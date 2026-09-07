/**
 * Detect whether the user's app has the Validity Expo config plugin
 * (`@validity.ai/verify-plugin-expo`) applied, and what URL scheme that app answers on.
 *
 * ADVISORY ONLY. Nothing here is ever a gate: the plugin is an optional
 * convenience (it guarantees the app owns a deep-link scheme and carries the
 * mocking deps), and the component playground works without it because it runs
 * against Validity's own COMPANION app, not the user's. Everything in this
 * module therefore degrades to `'unknown'` rather than failing.
 *
 * ATTESTED vs PROVEN. Two different claims live here and are kept apart:
 *
 *   - `listed` — `@validity.ai/verify-plugin-expo` appears in `expo.plugins`. That is an
 *     ASSERTION in a config file. It does not prove the plugin resolved, ran,
 *     or did anything.
 *   - `installed` — `expo.extra.validity` is present in the RESOLVED config.
 *     `@expo/config`'s `getConfig()` runs static config plugins before it
 *     returns, so a stamp in `expo config --json` output is an OBSERVATION that
 *     the plugin executed and produced the value alongside it.
 *
 * The readiness checklist reports the second and mentions the first only to
 * explain a mismatch (a listed-but-not-installed plugin usually means the
 * package is not installed, so Expo skipped or failed to resolve it).
 *
 * SCHEME PARITY. Two apps are in play and they must NOT share a scheme:
 * Validity's companion app (`.validity/native-app/`, whose scheme comes from
 * `defaultCompanionScheme` or a deliberate `native.scheme` override) and the
 * user's own app (whose scheme this plugin guarantees). If they ever match,
 * both installed apps answer one scheme, iOS routes `scheme://…`
 * nondeterministically, and a capture screenshots the WRONG app while exiting
 * 0. {@link schemeParityNote} detects that and says so; it never silently
 * prefers one over the other, because neither side owns the other's config.
 *
 * The whole module is pure apart from one injectable command runner, so it is
 * unit-testable with no Expo install, no project and no device.
 */
import { defaultRunner, type CommandRunner } from './agent-device-driver.js';
import { defaultCompanionScheme } from './prepare-native-app.js';

/** The npm package name of the Expo config plugin this module looks for. */
export const VALIDITY_EXPO_PLUGIN = '@validity.ai/verify-plugin-expo';

/** The `expo.extra` key the plugin stamps. Mirrors `VALIDITY_EXTRA_KEY` in that package. */
export const VALIDITY_EXPO_EXTRA_KEY = 'validity';

/**
 * What the resolved Expo config says about the plugin.
 *
 * ADD-ONLY: fields may be added, never removed or repurposed — a
 * `native-plugin-detect` consumer written against an older shape must keep
 * working.
 */
export interface NativePluginInfo {
  /**
   * PROVEN: the plugin ran (its stamp is in the resolved config). The only
   * field a readiness line should treat as authoritative.
   */
  installed: boolean;
  /**
   * ATTESTED: `@validity.ai/verify-plugin-expo` is listed in `expo.plugins`. Present
   * without `installed` means Expo did not apply it — almost always because the
   * package is not installed in the project.
   */
  listed: boolean;
  /** The scheme recorded in the stamp, when the plugin established one. */
  scheme?: string;
  /** The `@validity.ai/verify-plugin-expo` version that produced the stamp. */
  pluginVersion?: string;
  /**
   * Every URL scheme the RESOLVED config registers, read from `expo.scheme`,
   * `ios.infoPlist.CFBundleURLTypes` and `android.intentFilters`. Independent
   * of the stamp: an app with no plugin still has schemes, and the parity check
   * has to see all of them, not just the stamped one.
   */
  registeredSchemes: string[];
}

/**
 * `'unknown'` — the config could not be resolved at all (no Expo CLI, no
 * project, a crashing dynamic config, a timeout). Deliberately distinct from
 * `{ installed: false }`: "we could not look" and "we looked and it is not
 * there" produce different checklist wording, and conflating them is how an
 * advisory turns into a false claim.
 */
export type NativePluginDetection = NativePluginInfo | 'unknown';

interface ExpoConfigShape {
  scheme?: unknown;
  plugins?: unknown;
  extra?: unknown;
  ios?: unknown;
  android?: unknown;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function strings(value: unknown): string[] {
  return asArray(value).filter((v): v is string => typeof v === 'string' && v.length > 0);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Every scheme the resolved config registers, by all three mechanisms, in the
 * order `expo.scheme` → iOS → Android and de-duplicated. Mirrors
 * `discoverSchemes` in `@validity.ai/verify-plugin-expo` — duplicated rather than
 * imported on purpose: `@validity.ai/verify-native` must not depend on the plugin
 * package (the plugin is published standalone and must not drag the toolchain,
 * and it is not installed in a project that never added it).
 */
export function readRegisteredSchemes(exp: ExpoConfigShape): string[] {
  const found = [...strings(exp.scheme)];

  const infoPlist = record(record(exp.ios)?.['infoPlist']);
  for (const entry of asArray(infoPlist?.['CFBundleURLTypes'])) {
    const obj = record(entry);
    if (obj) found.push(...strings(obj['CFBundleURLSchemes']));
  }

  for (const filter of asArray(record(exp.android)?.['intentFilters'])) {
    const obj = record(filter);
    if (!obj) continue;
    for (const data of asArray(obj['data'])) {
      const d = record(data);
      const scheme = d?.['scheme'];
      if (typeof scheme === 'string' && scheme) found.push(scheme);
    }
  }

  return [...new Set(found)];
}

/** Is `@validity.ai/verify-plugin-expo` named in an `expo.plugins` array? */
function pluginListed(plugins: unknown): boolean {
  return asArray(plugins).some((entry) => {
    // A plugin entry is `"name"` or `["name", options]`.
    const name = Array.isArray(entry) ? entry[0] : entry;
    return typeof name === 'string' && name === VALIDITY_EXPO_PLUGIN;
  });
}

/**
 * Pull the JSON object out of a CLI's stdout.
 *
 * `npx expo config --json` is normally pure JSON, but the surrounding tooling
 * is chatty in ways that vary by version and environment (`env: load .env`
 * lines, npx install notices, dotenv banners). Rather than trusting the whole
 * buffer, fall back to the first `{` … last `}` span, which is unambiguous for
 * a single top-level object.
 */
function extractJsonObject(stdout: string): Record<string, unknown> | undefined {
  const attempt = (text: string): Record<string, unknown> | undefined => {
    try {
      const parsed: unknown = JSON.parse(text);
      return record(parsed);
    } catch {
      return undefined;
    }
  };
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  const direct = attempt(trimmed);
  if (direct) return direct;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  return attempt(trimmed.slice(start, end + 1));
}

/**
 * Parse `npx expo config --json` output into a detection.
 *
 * Tolerates both top-level shapes the Expo CLI has used: the bare `exp` object
 * and an `{ "expo": { … } }` wrapper.
 */
export function parseExpoConfigJson(stdout: string): NativePluginDetection {
  const parsed = extractJsonObject(stdout);
  if (!parsed) return 'unknown';
  const exp = (record(parsed['expo']) ?? parsed) as ExpoConfigShape;

  const stamp = record(record(exp.extra)?.[VALIDITY_EXPO_EXTRA_KEY]);
  const pluginVersion = stamp?.['pluginVersion'];
  const scheme = stamp?.['scheme'];

  return {
    // A stamp without a pluginVersion is not a stamp this plugin wrote — treat
    // it as absent rather than reporting a half-known install.
    installed: typeof pluginVersion === 'string',
    listed: pluginListed(exp.plugins),
    ...(typeof scheme === 'string' && scheme ? { scheme } : {}),
    ...(typeof pluginVersion === 'string' ? { pluginVersion } : {}),
    registeredSchemes: readRegisteredSchemes(exp),
  };
}

/** Options for {@link detectNativePlugin}. */
export interface DetectNativePluginOptions {
  /** The user's project root (NOT the generated companion app dir). */
  projectRoot: string;
  /** Injected command runner. Default: the package's spawn-based runner. */
  run?: CommandRunner;
  /**
   * Wall-clock bound. Resolving an Expo config evaluates the user's
   * `app.config.ts` through a TypeScript loader, which is slow on a cold cache
   * but never minutes. Bounded because this is an ADVISORY line on an
   * interactive command — it must not be able to hang a checklist.
   */
  timeoutMs?: number;
}

/** Default bound for the config resolution. Generous for a cold ts-node, still interactive. */
export const DEFAULT_PLUGIN_DETECT_TIMEOUT_MS = 25_000;

/**
 * Resolve the user's Expo config and report what it says about the plugin.
 *
 * `npx expo config --json` is used rather than an in-process `@expo/config`
 * require because it is the same command a user can run to check the answer
 * themselves — an advisory the user cannot reproduce is not much of an
 * advisory. It also picks up the project's own Expo version instead of
 * whatever happens to be resolvable from Validity.
 *
 * NEVER THROWS. Any failure — Expo not installed, no project, a dynamic config
 * that crashes, the timeout — is `'unknown'`.
 */
export async function detectNativePlugin(
  opts: DetectNativePluginOptions,
): Promise<NativePluginDetection> {
  const run = opts.run ?? defaultRunner;
  try {
    const res = await run('npx', ['expo', 'config', '--json'], {
      cwd: opts.projectRoot,
      timeoutMs: opts.timeoutMs ?? DEFAULT_PLUGIN_DETECT_TIMEOUT_MS,
      // Keep npx from interactively offering to install a missing `expo` — an
      // advisory probe must never block on a prompt, and installing a package
      // behind the user's back is not this command's business.
      env: { npm_config_yes: 'false', CI: '1' },
    });
    // A non-zero exit CAN still have printed a usable config (Expo warns on
    // stderr about all sorts of things), so parse first and only give up when
    // there is genuinely no object to read.
    const parsed = parseExpoConfigJson(res.stdout);
    if (parsed !== 'unknown') return parsed;
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Compare the USER app's schemes against the COMPANION app's scheme and return
 * a human-readable advisory, or `undefined` when there is nothing to say.
 *
 * PRECEDENCE — deliberately none. The plugin decides what the user's app
 * registers; `native.scheme` in `.validity/config.ts` (falling back to
 * `defaultCompanionScheme`) decides what the companion registers. Neither one
 * may overwrite the other, because each configures an app the other does not
 * own. When they collide this function says so and stops; resolving it is the
 * user's edit to make, in whichever of the two files they meant.
 *
 * @param detection what {@link detectNativePlugin} found for the user's app.
 * @param companionScheme the scheme the companion app registers.
 */
export function schemeParityNote(
  detection: NativePluginDetection,
  companionScheme: string,
): string | undefined {
  if (detection === 'unknown') return undefined;
  const collisions = detection.registeredSchemes.filter((s) => s === companionScheme);
  if (collisions.length === 0) return undefined;
  const isDefault = companionScheme === defaultCompanionScheme('ai.validity.playground');
  return (
    `Your app registers "${companionScheme}", which is also the Validity companion app's scheme` +
    (isDefault ? '' : ' (set via native.scheme in .validity/config.ts)') +
    '. With both apps installed, iOS resolves that scheme nondeterministically — a deep link can ' +
    "open the wrong app and the capture would screenshot it. Change one of them: your app's scheme " +
    'in your Expo config, or native.scheme in .validity/config.ts.'
  );
}
