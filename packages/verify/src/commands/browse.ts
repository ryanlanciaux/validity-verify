/**
 * `validity browse` — boots the Validity sandbox Vite server in
 * persistent mode and prints a URL the user can open in any browser to
 * iterate on components like Storybook. The same query-param protocol
 * verify uses (`?component=...&fixtures=...&scenario=...&propsId=...`)
 * drives what renders, so a copy-paste between browse and verify is a
 * perfect handoff.
 *
 * Lifecycle:
 *   1. Auto-config (`ensureValidityConfigured`) + `loadConfig` —
 *      identical to `validity__verify`'s setup. First-run users land
 *      in a state where browse just works without `validity init`.
 *   2. `prepareSandbox(projectRoot, config)` emits the index.html +
 *      entry.tsx into `node_modules/.validity/`.
 *   3. `startDevServer({ persist: true, config })` brings up Vite
 *      with the browse-mode middlewares wired (`/__validity/api/*`).
 *   4. Write `.browse.lock` so verify reuses this port and a second
 *      `validity browse` invocation refuses to double-boot.
 *   5. Block on SIGINT — Ctrl-C tears down Vite and removes the lock.
 *
 * The "Validity must not require `npm run dev`" contract is preserved:
 * browse runs Validity's own Vite over `node_modules/.validity/entry.tsx`,
 * NOT the user's app dev server.
 */
import { closeSync, existsSync, openSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import pc from 'picocolors';
import { loadConfig } from '@validity.ai/verify-spec';
import {
  buildCatalog,
  detectAppTarget,
  ensureValidityConfigured,
  resolveName,
} from '@validity.ai/verify-spec';
import {
  AgentDeviceDriver,
  BridgePortHeldError,
  browseNative,
  checkNativeReadiness,
  closeEstablishedNativeSessions,
  COMPANION_METRO_PORT,
  detectNative,
  detectNativePlugin,
  ensureCompanionMetro,
  isCompanionMetroUp,
  metroLogLength,
  metroServeSpawnEnv,
  prepareNativeApp,
  resolveNativeViewItems,
  schemeParityNote,
  resolveRemoteConfigPath,
  startNativeBridge,
  VALIDITY_EXPO_PLUGIN,
  waitForBundleServed,
  writeBuildMarker,
  type NativeBuildStep,
  type NativePluginDetection,
  type NativeRenderStatus,
} from '@validity.ai/verify-native';
import {
  browseLockPath,
  deleteBrowseLock,
  prepareExpoWeb,
  prepareSandbox,
  readLiveBrowseLock,
  resolveTarget,
  startDevServer,
  writeBrowseLock,
} from '@validity.ai/verify-web';

/**
 * How long to wait for the companion to (re)dial the control bridge before
 * treating the session as cold. The device reconnects on a ~2s loop after the
 * host process rebinds the bridge, so this covers a warm reconnect with a small
 * margin; if nothing connects in this window the app is on the launcher and we
 * cold-load the bundle instead of deep-linking into the void.
 */
const BRIDGE_WARM_RECONNECT_MS = 3500;

/**
 * Format the authoritative render status for the CLI (exported for tests).
 * browseNative no longer reports unconditional success — a device `{ok:false}`
 * ack or a settle fall-through must surface here instead of printing a green
 * "Opened …" over a stale/placeholder screen. `failed: true` means the caller
 * should exit non-zero so scripted/headless runs notice.
 */
export function formatNativeRenderStatus(
  render: NativeRenderStatus,
  targetLabel: string,
  appName: string,
  platform: string,
): { text: string; failed: boolean } {
  if (render.status === 'failed') {
    return {
      failed: true,
      text:
        pc.red(
          `Render FAILED for ${targetLabel}: ${render.error ?? 'the device reported a failed render'}\n`,
        ) +
        pc.dim(
          '  The device could not render this target (stale registry or unknown path). ' +
            'Re-run `validity browse --native` to rebuild the companion registry, then retry.\n',
        ),
    };
  }
  if (render.status === 'unconfirmed') {
    return {
      failed: false,
      text:
        pc.yellow(
          `Opened ${targetLabel} in the "${appName}" app (${platform}) — render UNCONFIRMED.\n`,
        ) +
        pc.dim(
          `  ${render.error ?? 'the device never confirmed the render'}\n` +
            '  The screen may still show the previous target or the dev launcher — re-run this command to retry.\n',
        ),
    };
  }
  return {
    failed: false,
    text: pc.green(
      `Opened ${targetLabel} in the "${appName}" app (${platform}) — render confirmed (${render.via}).\n`,
    ),
  };
}

/**
 * Format a BRIDGE_PORT_HELD failure for the CLI (exported for tests). The
 * bridge port is occupied by a non-Validity process and delegation is
 * impossible — the error message (machine-readable `BRIDGE_PORT_HELD:` prefix)
 * is kept verbatim and first, followed by the concrete unblock. Always a
 * non-zero-exit condition: nothing was rendered or confirmed.
 */
export function formatBridgePortHeld(err: Error): string {
  return (
    pc.red(`${err.message}\n`) +
    pc.dim(
      '  Nothing was rendered. Free the bridge port (close the process or other validity session holding it), then re-run.\n',
    )
  );
}

export interface BrowseOptions {
  cwd?: string;
  component?: string;
  fixtures?: string;
  scenario?: string;
  port?: number;
  open?: boolean;
  /** React Native playground mode — drive a booted simulator/emulator. */
  native?: boolean;
  /**
   * Explicit opt-in to the Expo Web (`react-native-web`) proxy on an RN/Expo
   * project, which otherwise browses on a device.
   */
  web?: boolean;
  platform?: 'ios' | 'android';
  scheme?: string;
}

/**
 * Does this project browse on a device? Detection (one package.json read)
 * decides first; only a project that HAS a native path pays for a config load
 * to check for an explicit `expo-web` opt-in. A web project never loads the
 * config twice on its way to the same answer.
 */
async function browsesOnDevice(projectRoot: string): Promise<ReturnType<typeof detectAppTarget>> {
  const shallow = detectAppTarget(projectRoot);
  if (!shallow.nativeAvailable) return shallow;
  let configFramework: string | undefined;
  try {
    configFramework = (await loadConfig(projectRoot)).config.framework;
  } catch {
    // No config yet (or unloadable) — detection decides on its own.
  }
  return detectAppTarget(projectRoot, { configFramework });
}

export async function runBrowse(opts: BrowseOptions = {}): Promise<void> {
  const projectRoot = opts.cwd ? resolve(opts.cwd) : process.cwd();

  // Native playground branch — entirely separate from the web Vite flow.
  if (opts.native) {
    await runBrowseNative(projectRoot, opts);
    return;
  }

  // React Native / Expo with no explicit web opt-in browses ON THE DEVICE.
  // "Show me this screen" means the real thing; a react-native-web rendering
  // is close enough to be mistaken for it, which is why it needs to be asked
  // for by name rather than chosen for the user.
  if (!opts.web) {
    const appTarget = await browsesOnDevice(projectRoot);
    if (appTarget.recommended === 'native') {
      process.stdout.write(
        pc.dim(
          `${appTarget.kind === 'expo' ? 'Expo' : 'React Native'} app detected — browsing on the ` +
            `simulator/emulator (--web for the Expo Web proxy).\n`,
        ),
      );
      await runBrowseNative(projectRoot, opts);
      return;
    }
  }

  // Refuse to boot on top of an existing live browse server. Print the
  // URL so the user can just open the existing one; exit 0 because
  // "browse is already up" is the *expected* outcome of the user
  // re-running the command in a second terminal. If the user passed a
  // component arg, resolve it against the running config and append a
  // `?focus=` query so the printed URL lands directly on that component
  // — this is the agent-friendly "show me the StreamingAnalysisView"
  // affordance.
  const existing = readLiveBrowseLock(projectRoot);
  if (existing) {
    let url = `http://127.0.0.1:${existing.port}/`;
    let focusResolved: string | undefined;
    if (opts.component) {
      try {
        const { config: liveConfig } = await loadConfig(projectRoot);
        focusResolved =
          resolveComponentRef(opts.component, projectRoot, liveConfig.components ?? {}) ??
          undefined;
        if (focusResolved) {
          url = `${url}?focus=${encodeURIComponent(focusResolved)}`;
          if (opts.scenario) url += `&scenario=${encodeURIComponent(opts.scenario)}`;
        }
      } catch {
        // Config load failed — fall through with the bare URL.
      }
    }
    process.stdout.write(
      pc.yellow('Browse server already running.\n') +
        `  url:        ${url}\n` +
        `  pid:        ${existing.pid}\n` +
        `  startedAt:  ${existing.startedAt}\n`,
    );
    if (opts.component && !focusResolved) {
      process.stdout.write(
        pc.yellow(`  ! couldn't resolve "${opts.component}" — opening base URL\n`),
      );
    }
    if (opts.component && focusResolved && focusResolved !== opts.component) {
      process.stdout.write(pc.dim(`  resolved "${opts.component}" → ${focusResolved}\n`));
    }
    process.stdout.write(
      pc.dim('  (Re-run with Ctrl-C in the original terminal first if you want a fresh boot.)\n'),
    );
    if (opts.open !== false && opts.component && focusResolved) {
      openInBrowser(url);
    }
    return;
  }

  // Bootstrap / refresh `.validity/wrapper.gen.tsx` and `.validity/config.ts`
  // — same auto-config the MCP verify handler runs.
  const ensureResult = await ensureValidityConfigured({ projectRoot });
  if (ensureResult.status === 'manual-required') {
    process.stderr.write(
      pc.red('Setup needs attention before browse can run.\n') +
        ensureResult.warnings.map((w) => `  ${w}\n`).join('') +
        (ensureResult.manualSteps ?? []).map((s) => `  • ${s}\n`).join(''),
    );
    process.exit(1);
  }

  const loaded = await loadConfig(projectRoot);
  // `--web` on an RN/Expo project is the explicit Expo Web opt-in — pin the
  // target so resolveTarget serves it instead of refusing.
  const config =
    opts.web && (loaded.config.framework === 'auto' || loaded.config.framework === 'expo-native')
      ? { ...loaded.config, framework: 'expo-web' as const }
      : loaded.config;

  // Materialize the sandbox (entry.tsx, index.html, validity-msw.ts) so
  // the dev server has something to serve. Expo Web needs its own prepare +
  // alias set (react-native → react-native-web); everything else takes the
  // standard web path. Verify does the same switch in render.ts.
  const target = resolveTarget(config.framework, projectRoot);
  if (target === 'expo-web') prepareExpoWeb(projectRoot, config);
  else prepareSandbox(projectRoot, config);

  const dev = await startDevServer(projectRoot, {
    persist: true,
    config,
    target,
    preferredPort: opts.port,
  });

  // Resolve the user-supplied component reference to a real project key.
  // Order: (1) literal config key, (2) existing file on disk relative to
  // projectRoot, (3) fuzzy match against config.components keys.
  let resolvedComponent: string | undefined = opts.component;
  if (resolvedComponent) {
    const resolved = resolveComponentRef(resolvedComponent, projectRoot, config.components ?? {});
    if (!resolved) {
      process.stderr.write(
        pc.yellow(
          `! couldn't resolve "${resolvedComponent}" to a known component — opening the browser anyway. Use ⌘P inside the UI to pick one.\n`,
        ),
      );
      resolvedComponent = undefined;
    } else {
      if (resolved !== resolvedComponent) {
        process.stdout.write(pc.dim(`  resolved "${resolvedComponent}" → ${resolved}\n`));
      }
      resolvedComponent = resolved;
    }
  }

  // The browse UI uses `?focus=` (not `?component=`) for the persistent
  // canvas selection; `?component=` is the per-iframe URL contract that
  // boots a single render. Use focus when we have a value.
  const params = buildQuery({
    focus: resolvedComponent,
    fixtures: opts.fixtures,
    scenario: opts.scenario,
  });
  const url = params ? `${dev.url}/?${params}` : dev.url + '/';

  // Lock — verify uses this to reuse the running server; a 2nd browse
  // command uses it to refuse boot.
  writeBrowseLock(projectRoot, {
    pid: process.pid,
    port: dev.port,
    startedAt: new Date().toISOString(),
  });

  process.stdout.write(
    pc.bold('Validity browse ') +
      pc.dim(`(pid ${process.pid}, port ${dev.port})\n`) +
      pc.green(`  ${url}\n`) +
      pc.dim(`  lock: ${browseLockPath(projectRoot)}\n`) +
      pc.dim('  Ctrl-C to stop. Verify runs (validity__verify) will reuse this server.\n'),
  );

  if (opts.open !== false) {
    openInBrowser(url);
  }

  // Cleanup on any kind of exit. We register both SIGINT/SIGTERM and
  // a process.on('exit') belt-and-suspenders — Vite's close() needs to
  // run to release the port, and the lock needs to be removed so the
  // next `validity browse` doesn't think it's still alive.
  const shutdown = async (signal: string) => {
    process.stderr.write(pc.dim(`\n[${signal}] tearing down browse server…\n`));
    try {
      await dev.close();
    } catch {
      // Vite occasionally throws on close — not fatal.
    }
    // Awaited HERE rather than left to the process-wide signal handler because
    // the `process.exit(0)` below would truncate it: a `--native` browse holds
    // an agent-device session, and a session that exits without a close leaves
    // the device claim the next run reports as phantom.
    await closeEstablishedNativeSessions();
    deleteBrowseLock(projectRoot);
    process.exit(0);
  };
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('exit', () => {
    deleteBrowseLock(projectRoot);
  });

  // Block forever — the dev server runs on Vite's internal event loop,
  // but Node would exit if nothing kept the main loop alive.
  await new Promise(() => {});
}

/**
 * Format the OPTIONAL app-plugin advisory that follows the `--native` readiness
 * checklist. Returns `''` when there is nothing honest to say.
 *
 * This is not part of the checklist and must never read like it: every step in
 * the checklist is a prerequisite for the COMPANION playground, whereas
 * `@validity.ai/verify-plugin-expo` configures the USER's own app — it is what makes the
 * app itself deep-linkable (`.ad` device journeys, dev-client control links)
 * and it carries the JS mocking deps. Nothing here can block anything.
 *
 * The scheme line is a COLLISION check, not a match check. The companion app
 * and the user's app are two apps on one device; if they register the same
 * scheme, iOS resolves `scheme://…` nondeterministically and a capture can
 * screenshot the wrong app while still exiting 0. Neither side's config is
 * rewritten to fix it — the note names both files and stops.
 *
 * Exported for the same reason `formatNativeRenderStatus` is: the wording is
 * the product here, so it is pinned at the function boundary in tests.
 */
export function formatAppPluginAdvisory(
  detection: NativePluginDetection,
  companionScheme: string,
): string {
  // 'unknown' = we could not resolve the Expo config (no Expo CLI, a dynamic
  // config that threw, a timeout). Silence is the honest output: an advisory
  // that could not be computed must not be reported either way.
  if (detection === 'unknown') return '';

  let text = pc.bold('Your app (optional):\n');
  if (detection.installed) {
    const version = detection.pluginVersion ? ` v${detection.pluginVersion}` : '';
    const scheme = detection.scheme
      ? `your app answers "${detection.scheme}"`
      : 'no scheme established — add a "scheme" to your Expo config';
    text += `  ${pc.green('✓')} App plugin ${pc.dim(`— ${VALIDITY_EXPO_PLUGIN}${version}; ${scheme}`)}\n`;
  } else {
    const why = detection.listed
      ? `listed in expo.plugins but it did not run — is ${VALIDITY_EXPO_PLUGIN} installed?`
      : 'not installed. It gives your app a deep-link scheme and carries the mocking deps.';
    text += `  ${pc.dim('·')} App plugin ${pc.dim(`— ${why}`)}\n`;
    text += pc.cyan(`      npx expo install ${VALIDITY_EXPO_PLUGIN}\n`);
    if (detection.registeredSchemes.length === 0) {
      text +=
        `  ${pc.dim('·')} App URL scheme ` +
        pc.dim('— your app declares none, so it cannot be deep-linked directly.\n');
    }
  }

  const parity = schemeParityNote(detection, companionScheme);
  if (parity) text += pc.yellow(`  ! ${parity}\n`);
  return text + '\n';
}

/**
 * Resolve the user's Expo config and print {@link formatAppPluginAdvisory}.
 * Never throws and never blocks the walkthrough — `detectNativePlugin` already
 * degrades every failure to `'unknown'`, which formats to nothing.
 */
async function writeAppPluginAdvisory(
  out: { write: (chunk: string) => unknown },
  projectRoot: string,
  companionScheme: string,
): Promise<void> {
  const detection = await detectNativePlugin({ projectRoot }).catch(
    () => 'unknown' as NativePluginDetection,
  );
  const text = formatAppPluginAdvisory(detection, companionScheme);
  if (text) out.write(text);
}

/**
 * `validity browse --native [component]` — the React Native playground.
 * Generates a SEPARATE "Validity" companion app (installed beside the real
 * app — no flipping the user's root), builds it once if needed, then deep-links
 * to mount ONE component in isolation with mocked network/nav/auth.
 */
async function runBrowseNative(projectRoot: string, opts: BrowseOptions): Promise<void> {
  const out = process.stdout;
  // Guard the classic footgun: a shell left cd'd INSIDE the generated companion
  // app. Generating from there reads the wrong tsconfig (no `@/` path aliases →
  // broken imports) and nests a .validity/native-app/.validity/native-app. Walk
  // back up to the real project root.
  projectRoot = escapeGeneratedNativeApp(projectRoot, out);
  await ensureValidityConfigured({ projectRoot }).catch(() => {});
  const { config } = await loadConfig(projectRoot);

  const detection = detectNative(projectRoot);
  if (!detection.isNative) {
    process.stderr.write(pc.red(`Not a React Native / Expo project: ${detection.reason}\n`));
    process.exit(1);
  }

  const platform = opts.platform ?? (config.native?.target === 'android' ? 'android' : 'ios');
  const scheme = opts.scheme ?? config.native?.scheme;
  const app = prepareNativeApp({ projectRoot, config, scheme, platform });
  out.write(
    pc.bold(`Validity companion app "${app.appName}"\n`) +
      pc.dim(`  generated: ${app.appDir}\n`) +
      pc.dim(`  scheme: ${app.scheme} · bundle: ${app.bundleId}\n`) +
      pc.dim(`  registered ${app.prepared.registeredComponents.length} components/screens\n`) +
      pc.dim(`  a separate dev app — your app is never edited or swapped\n\n`),
  );

  // Walkthrough: show the readiness checklist, stop at the first blocker.
  const readiness = await checkNativeReadiness({
    projectRoot,
    platform,
    scheme: app.scheme,
    bundleId: app.bundleId,
    buildHash: app.buildHash,
    buildMarkerPath: app.buildMarkerPath,
    // Lets a stale install's message name WHICH input flipped (dep version /
    // expo config) by diffing against the marker's persisted inputs.
    buildInputs: app.buildInputs,
  });
  out.write(pc.bold('Readiness:\n'));
  for (const step of readiness.steps) {
    const icon = step.status === 'ok' ? pc.green('✓') : pc.yellow('→');
    out.write(`  ${icon} ${step.label} ${pc.dim('— ' + step.detail)}\n`);
    if (step.status === 'todo' && step.action) out.write(pc.cyan(`      ${step.action}\n`));
  }
  out.write('\n');

  // ADVISORY, and only on the walkthrough (`validity browse --native` with no
  // component — the "am I set up?" invocation). Resolving the user's Expo config
  // shells out to `npx expo config --json`, which is seconds on a cold ts-node
  // loader; paying that on every `browse --native Button` re-target would tax
  // the hot path for a line nobody asked for.
  if (!opts.component) await writeAppPluginAdvisory(out, projectRoot, app.scheme);

  // Blocked on a prerequisite other than the build itself → stop with the
  // single next action (the checklist already printed the command).
  if (readiness.nextAction && readiness.nextAction.id !== 'companion-app') {
    out.write(
      pc.yellow(
        `Next: ${readiness.nextAction.label} — ${readiness.nextAction.action ?? readiness.nextAction.detail}\n`,
      ),
    );
    process.exitCode = 1;
    return;
  }

  // Did this run sever the device's warm session? A content `--clear` Metro
  // restart kills the dev server the running app is attached to, dropping it off
  // Metro back to the dev-client launcher — genuinely COLD. In that case the
  // open MUST load the bundle (control link), not just deep-link, or it strands
  // on the launcher. Tracked here so the open policy below can preload.
  let metroRestartedForContent = false;

  // Only the companion app is missing → build + install it once (everything
  // else is ready). Validity runs the WHOLE sequence (install → prebuild
  // --clean → pod install → run) non-interactively so the user doesn't.
  if (readiness.nextAction?.id === 'companion-app') {
    out.write(
      pc.yellow(`Building "${app.appName}" once (separate app; your app untouched)…\n`) +
        pc.dim(`  mirrored ${app.mirroredDepCount} host deps so native modules autolink\n\n`),
    );
    const steps = app.buildSteps(platform);
    // Every step terminates, including expo run --no-bundler. Do not record a
    // build until compilation AND installation have actually completed.
    for (const step of steps) {
      out.write(pc.bold(`▶ ${step.label}`) + pc.dim(` (${step.bin} ${step.args.join(' ')})\n`));
      const code = await runInherited(step.bin, step.args, step.cwd, step.env);
      if (code !== 0) {
        process.stderr.write(
          pc.red(
            `Step "${step.label}" exited ${code}. Fix the above, then re-run \`validity browse --native\`.\n` +
              (step.bin === 'pnpm'
                ? `For ERR_PNPM_IGNORED_BUILDS, review scripts with \`pnpm approve-builds\` inside ${app.appDir}; do not enable all scripts blindly.\n`
                : ''),
          ),
        );
        process.exitCode = code;
        return;
      }
    }
    // Record the build (hash + the inputs it was derived from) so a later run
    // with the same binary inputs skips the rebuild, and a future mismatch can
    // be diffed to name its cause in the readiness checklist.
    writeBuildMarker(app.buildMarkerPath, app.buildHash, app.buildInputs);
  }
  {
    // Build is fresh + installed, but the deep link only renders if Metro is
    // serving the bundle the dev-client connects to. A prior session's Metro
    // may have been killed — bring it back up (no rebuild) before navigating.
    // Pass contentHash so a regenerated file (a fixed polyfills/mocks body, a
    // new view) forces a --clear restart instead of serving a stale transform.
    if (!(await isCompanionMetroUp())) {
      out.write(pc.dim(`Companion Metro not running — starting it on ${COMPANION_METRO_PORT}…\n`));
    }
    const metro = await ensureCompanionMetro(app.appDir, {
      contentHash: app.contentHash,
      contentMarkerPath: app.metroContentMarkerPath,
    });
    if (metro.restartedForContent) {
      metroRestartedForContent = true;
      out.write(pc.dim(`Companion content changed — restarted Metro with a clean cache.\n`));
    }
    if (!metro.up) {
      out.write(
        pc.yellow(
          metro.earlyExitCode !== undefined
            ? `Metro crashed on boot (exit ${metro.earlyExitCode}). Fix the log error and re-run browse. Log: ${metro.logPath}\n`
            : `Metro didn't come up on ${COMPANION_METRO_PORT}. Check the log and re-run browse. Log: ${metro.logPath}\n`,
        ),
      );
      process.exitCode = 1;
      return;
    }
    if (metro.ownershipUnconfirmed) {
      // /status answered but the port couldn't be attributed to the Metro we
      // just spawned — a surviving old server may be serving STALE content.
      // The content marker was deliberately not advanced, so the next run
      // retries the --clear restart instead of trusting this session.
      out.write(
        pc.yellow(
          `A Metro is answering on ${COMPANION_METRO_PORT} but it doesn't look like the one just started — ` +
            `cannot confirm current content. Check the log and re-run browse. Log: ${metro.logPath}\n`,
        ),
      );
      process.exitCode = 1;
      return;
    }
  }

  if (!opts.component) {
    out.write(pc.dim('Ready. Open a component: validity browse --native Button\n'));
    return;
  }

  // Resolve the casual name to a concrete path (never guess on a tie).
  const catalog = buildCatalog(projectRoot, config);
  const resolved = resolveName(opts.component, catalog);
  if (resolved.matches.length === 0) {
    process.stderr.write(pc.yellow(`No component matched "${opts.component}".\n`));
    return;
  }
  if (!resolved.best) {
    process.stderr.write(pc.yellow(`"${opts.component}" is ambiguous:\n`));
    for (const m of resolved.matches.slice(0, 5)) process.stderr.write(`  • ${m.path}\n`);
    return;
  }
  const targetName = resolved.best.path;
  const isView = resolved.best.kind === 'view';

  // projectRoot doubles as the spawn cwd: agent-device keys sessions by CWD,
  // so this pins the CLI and MCP paths to the SAME session for this project.
  const browseRemoteConfigPath = resolveRemoteConfigPath(config.native, projectRoot);
  const driver = new AgentDeviceDriver({
    platform,
    scheme: app.scheme,
    projectRoot,
    cwd: projectRoot,
    // Remote device profile (native.remote) — same --remote-config every other
    // agent-device command gets; unset leaves the local path byte-identical.
    ...(browseRemoteConfigPath ? { remoteConfigPath: browseRemoteConfigPath } : {}),
  });
  // Own a control bridge so the CLI gets the SAME in-place, per-token re-target
  // as the MCP path ("show me Button" then "show me Radio" swaps in place, no
  // reload). If an MCP server already owns port 8083, this handle DELEGATES the
  // navigate through its HTTP /navigate endpoint (still per-token acked) instead
  // of silently degrading to the deep-link ladder; a non-Validity holder
  // surfaces as a machine-readable BRIDGE_PORT_HELD error below. MUST be closed
  // on exit or it leaks the WS server / holds the port.
  const bridge = startNativeBridge();
  // Publish the DATA payload for the device's boot fetch (GET /data) — a
  // cold/reloaded companion picks up fresh views/scenarios/mock without a
  // rebuild, mirroring the MCP path. Cheap (just data), idempotent.
  bridge.setNativeData(app.prepared.dataPayload);
  // Ship the view's resolved items inline (deep-link `items=`) so a view renders
  // without being baked into the running bundle — no native rebuild per view.
  const viewItems = isView
    ? resolveNativeViewItems(
        config.views?.[targetName],
        new Set(app.prepared.registeredComponents),
        config.components ?? {},
      )
    : undefined;
  // Ship the resolved scenario seed + mock-network config inline over the bridge
  // so a scenario/mock edit re-targets a warm device as DATA (no rebuild).
  const scenarioSeed = opts.scenario
    ? app.prepared.dataPayload.scenarios[opts.scenario]
    : undefined;
  const mockNetwork = app.prepared.dataPayload.mockNetwork;
  const spec = isView
    ? { view: targetName, viewItems, scenario: opts.scenario, scenarioSeed, mockNetwork }
    : { component: targetName, scenario: opts.scenario, scenarioSeed, mockNetwork };
  const cmd = driver.openTargetCommand(spec);

  try {
    // Warm vs cold open policy. We wait briefly for the device to (re)connect
    // in EVERY case — including after a content --clear restart: a live
    // reconnecting companion is exactly what lets the open below refresh it
    // with a cheap bridge-pushed IN-PLACE reload (the companion ships no
    // expo-splash-screen, so a reload can't strand behind a stuck launch
    // screen) instead of the terminate + control-link + fixed-sleep ladder.
    // If it connects and content is unchanged, re-target warm (skipPreload);
    // if nothing connects, the app is cold on the launcher and skipPreload
    // would strand it there, so we DON'T skip — browseNative cold-loads the
    // bundle and dismisses the dev menu.
    const connected = await bridge.waitForConnection(BRIDGE_WARM_RECONNECT_MS);
    // Cold opens gate on OBSERVED bundle readiness (Metro's "Bundled" log line)
    // instead of a fixed 4s sleep — a post---clear first bundle takes 30-90s and
    // would otherwise time out every confirmation rung against the launcher.
    // The offset is captured NOW so only output from THIS open's bundle request
    // can satisfy the wait.
    const metroLogPath = resolve(app.appDir, 'validity-native.log');
    const metroLogOffset = metroLogLength(metroLogPath);
    const result = await browseNative(driver, spec, {
      bridge,
      // skipPreload pins warm-only; never pin when content changed (a warm
      // re-target would ack the STALE bundle), and never pin a disconnected
      // device (it would strand on the launcher).
      skipPreload: connected && !metroRestartedForContent,
      // A content --clear restart severs the running app's HMR socket; the app
      // re-dials the bridge the moment we rebind it, and a warm re-target would
      // then confidently ack a STALE bundle as success. forceReload refreshes
      // it instead: a bridge-pushed in-place reload when the reconnected
      // companion is reload-capable, terminate + genuine cold launch as the
      // final fallback — and the fresh contentHash below lets the device's own
      // hello prove staleness even when this CLI run didn't restart Metro.
      forceReload: metroRestartedForContent,
      bundleId: app.bundleId,
      // MUST be the PREPARED hash (prepareNative's own), not app.contentHash:
      // the device bakes prepared.contentHash into validity-content-hash.ts and
      // echoes it in its hello, while app.contentHash re-hashes prepared +
      // app-shell bodies — comparing against the combined hash would read EVERY
      // fresh bundle as stale and terminate every warm session.
      expectedContentHash: app.prepared.contentHash,
      waitForBundle: () =>
        waitForBundleServed({ logPath: metroLogPath, sinceOffset: metroLogOffset }),
    });
    // Surface the authoritative render status — a failed/unconfirmed render
    // must never print as a green "Opened …" (the old silent-success bug).
    const status = formatNativeRenderStatus(
      result.render,
      isView ? `view "${targetName}"` : targetName,
      app.appName,
      platform,
    );
    out.write(status.text);
    out.write(pc.dim(`  ${result.url}\n`));
    // Timing breakdown (debug): the navigate→render-ack phase, so a future
    // open-path slowdown is visible instead of hiding in an opaque round-trip.
    out.write(pc.dim(`  navigate→ack ${result.timing.openMs}ms\n`));
    if (status.failed) process.exitCode = 1;
  } catch (err) {
    if (err instanceof BridgePortHeldError) {
      // Machine-readable: the bridge port is occupied by a non-Validity process
      // and delegation is impossible. Loud + non-zero instead of silently
      // degrading to the splash-prone deep-link ladder.
      out.write(formatBridgePortHeld(err));
      process.exitCode = 1;
      return;
    }
    out.write(pc.yellow(`Couldn't drive the device: ${(err as Error).message}\n`));
    out.write(pc.dim(`Open it manually with:\n  ${cmd.bin} ${cmd.args.join(' ')}\n`));
    process.exitCode = 1;
  } finally {
    bridge.close();
  }
}

/** Run a command inheriting stdio (for the `expo prebuild`/`run:*` build steps). */
function runInherited(
  bin: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<number> {
  return new Promise((res) => {
    const child = spawn(bin, args, {
      cwd,
      stdio: 'inherit',
      env: env ? { ...process.env, ...env } : process.env,
    });
    child.on('error', () => res(127));
    child.on('close', (code) => res(code ?? 1));
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Spawn a never-exiting step (the `expo run` / `expo start` Metro server)
 * DETACHED so it keeps serving after this command returns, then POLL a
 * readiness predicate instead of awaiting its close. This is what unblocks the
 * build loop: `expo run` stays attached to Metro and never closes, so treating
 * it as a normal awaited step hangs forever. Output is tee'd to a log file so a
 * failed build is still triageable. Returns true once ready, false on timeout
 * or an early non-zero exit.
 *
 * Long-running steps are exactly the Metro-SERVING ones, so the child env is
 * assembled with metroServeSpawnEnv: step env over the parent's, with any
 * inherited `CI`/`CONTINUOUS_INTEGRATION` STRIPPED — an agent harness
 * exporting CI=1 would otherwise disable Metro's file watcher and kill Fast
 * Refresh (the one-shot build steps keep their env untouched; CI is fine —
 * deliberate, even — there).
 */
async function startLongRunning(
  step: NativeBuildStep,
  out: NodeJS.WriteStream,
  opts: { ready: () => Promise<boolean>; readyLabel: string; timeoutMs?: number; pollMs?: number },
): Promise<boolean> {
  const logPath = resolve(step.cwd, 'validity-native.log');
  const fd = openSync(logPath, 'a');
  out.write(
    pc.bold(`▶ ${step.label}`) +
      pc.dim(` (${step.bin} ${step.args.join(' ')}) — background; log: ${logPath}\n`),
  );
  const child = spawn(step.bin, step.args, {
    cwd: step.cwd,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: metroServeSpawnEnv(process.env, step.env),
  });
  closeSync(fd);
  child.unref();
  let earlyExit: number | null = null;
  child.on('error', () => {
    earlyExit = 127;
  });
  child.on('exit', (code) => {
    earlyExit = code ?? 1;
  });

  const timeoutMs = opts.timeoutMs ?? 600_000;
  const pollMs = opts.pollMs ?? 3_000;
  const start = Date.now();
  // Probe-then-sleep: an already-satisfied predicate (Metro/app instantly up,
  // e.g. an `expo start` reusing a warm cache) must not pay a guaranteed
  // first-poll floor — the old sleep-first loop cost 3s on every spawn.
  while (Date.now() - start < timeoutMs) {
    const ready = await opts.ready();
    // Check the child failure first: an old app/Metro can still answer ready.
    // A non-zero exit before readiness means the build/launch failed — stop
    // polling and surface the log. (expo run exiting 0 shouldn't happen while
    // it owns Metro, but if it does, keep polling: the app may still be up.)
    if (earlyExit !== null && earlyExit !== 0) {
      out.write(
        pc.red(`  ${step.label} exited ${earlyExit} before becoming ready (see ${logPath}).\n`),
      );
      return false;
    }
    if (ready) {
      out.write(pc.green(`  ✓ ${opts.readyLabel}\n`));
      return true;
    }
    await sleep(pollMs);
  }
  return false;
}

/**
 * If `root` is inside a generated companion app (…/.validity/native-app[/…]),
 * return the real project root above it; otherwise return `root` unchanged.
 * Prevents regenerating from the wrong directory (wrong tsconfig → no `@/`
 * aliases) and the nested-turducken build.
 */
function escapeGeneratedNativeApp(root: string, out: NodeJS.WriteStream): string {
  const marker = `${sep}.validity${sep}native-app`;
  const idx = root.indexOf(marker);
  if (idx === -1) return root;
  const real = root.slice(0, idx);
  out.write(
    pc.yellow(`You're inside a generated companion app — using the real project root:\n`) +
      pc.dim(`  ${real}\n\n`),
  );
  return real;
}

function buildQuery(parts: { focus?: string; fixtures?: string; scenario?: string }): string {
  const search = new URLSearchParams();
  if (parts.focus) search.set('focus', parts.focus);
  if (parts.fixtures) search.set('fixtures', parts.fixtures);
  if (parts.scenario) search.set('scenario', parts.scenario);
  return search.toString();
}

/**
 * Resolve a user-supplied component reference to a config key, in order:
 *   1. Exact key match in `components`.
 *   2. Existing file on disk under projectRoot (turns absolute or
 *      project-relative paths into their canonical config-key form).
 *   3. Fuzzy match against config keys + basenames so a user can type
 *      `StreamingAnalysisView` or `streaminganalysis` and have it land
 *      on `src/components/StreamingAnalysisView.tsx`. The match is
 *      case-insensitive and tolerates extra prefixes/suffixes.
 *
 * Returns null when no candidate clears a reasonable threshold so the
 * caller can warn and open the picker instead of taking the user to a
 * random component.
 */
export function resolveComponentRef(
  query: string,
  projectRoot: string,
  components: Record<string, unknown>,
): string | null {
  const keys = Object.keys(components);
  // 1. Exact key.
  if (components[query] !== undefined) return query;

  // 2. Filesystem path. Accept absolute, project-relative, and
  // ./ prefixed forms; collapse to a project-relative key.
  const stripped = query.replace(/^\.\//, '');
  const abs = stripped.startsWith('/') ? stripped : resolve(projectRoot, stripped);
  if (existsSync(abs)) {
    const rel = abs.startsWith(projectRoot + '/') ? abs.slice(projectRoot.length + 1) : abs;
    if (components[rel] !== undefined) return rel;
    // Even if not in `components` yet, return the relative path — the
    // browse server auto-discovers component files and will materialize it.
    return rel;
  }

  // 3. Fuzzy match. Score every key and basename, take the best — but
  // require a clear winner to avoid silently mis-routing the user.
  if (keys.length === 0) return null;
  const q = query.toLowerCase().replace(/\.(tsx?|jsx?)$/, '');
  type Hit = { key: string; score: number };
  const hits: Hit[] = keys.map((k) => {
    const base = k.split('/').pop() ?? k;
    const baseStem = base.replace(/\.(tsx?|jsx?)$/, '').toLowerCase();
    const pathStem = k.toLowerCase();
    const baseScore = scoreFuzzy(q, baseStem);
    const pathScore = scoreFuzzy(q, pathStem);
    return { key: k, score: Math.max(baseScore, pathScore - 1) };
  });
  hits.sort((a, b) => b.score - a.score);
  const best = hits[0];
  if (!best || best.score < 4) return null;
  return best.key;
}

function scoreFuzzy(q: string, t: string): number {
  if (!q) return 0;
  if (t === q) return 1000;
  if (t.includes(q)) return 500 - t.indexOf(q) * 2;
  // Subsequence scoring (each matched char +4, streak bonus).
  let qi = 0;
  let streak = 0;
  let score = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      streak += 1;
      score += 4 + streak * 2;
      qi += 1;
    } else {
      streak = 0;
    }
  }
  if (qi < q.length) return -1;
  return score;
}

/**
 * Cross-platform "open URL in default browser." We avoid the npm `open`
 * package to keep the CLI's dep tree lean — the right system command
 * differs by platform but the shape is the same on each. Best-effort:
 * any failure is swallowed (the URL is already printed for the user).
 */
function openInBrowser(url: string): void {
  let cmd: string;
  let args: string[];
  if (process.platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (process.platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '""', url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    // best-effort
  }
}
