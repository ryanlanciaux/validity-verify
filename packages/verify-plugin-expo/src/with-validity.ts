/**
 * `withValidity` — the Validity Expo config plugin.
 *
 * WHAT IT DOES (all of it):
 *
 *   1. Guarantees the app owns a deep-link URL scheme OF ITS OWN, so Validity
 *      can drive it on a device (`.ad` journeys, dev-client control links).
 *      An app that already declares a scheme keeps exactly the scheme it has.
 *   2. Stamps `expo.extra.validity = { pluginVersion, scheme }` so Validity's
 *      readiness checks can PROVE the plugin ran, and can read back which
 *      scheme the app answers on.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *
 *   - It does not register a Validity-branded scheme. The Validity COMPANION
 *     app (the component playground under `.validity/native-app/`) derives its
 *     own unique scheme so that it can never collide with an app the user has
 *     installed; if this plugin also put a `validity-*` scheme on the user's
 *     app, two installed apps would answer one scheme and iOS would route
 *     `scheme://…` nondeterministically — the deep link "succeeds" into the
 *     wrong app and the capture screenshots the wrong pixels while exiting 0.
 *     See `deep-link.ts` in `@validity.ai/verify-native`, whose error text says the same
 *     thing from the other side.
 *   - It does not write `ios.infoPlist.CFBundleURLTypes` or
 *     `android.intentFilters` itself. `expo.scheme` is the single mechanism
 *     `expo prebuild` compiles into BOTH of those (its own `withScheme` mod
 *     appends the iOS URL type and the Android `<data android:scheme>`), and
 *     `expo-linking`'s `Linking.createURL()` reads `expo.scheme` — writing the
 *     raw platform keys instead would satisfy prebuild while leaving the JS
 *     side blind, and writing BOTH would emit duplicate native registrations.
 *     Those two fields ARE read, as evidence that an app which hand-rolls its
 *     URL types already owns a scheme (see `discoverSchemes`).
 *   - It does not install a runtime dev hook. Validity's settle gate is driven
 *     by the companion's WebSocket control bridge and its per-navigation
 *     `validity-root:<token>` paint marker; both are statements about a
 *     playground that mounts one registry component on demand, and neither has
 *     a meaning inside an ordinary app. See README.md § "Why there is no dev hook".
 *   - It does not read `.validity/config.ts`. `native.scheme` there configures
 *     the COMPANION; this plugin configures the USER's app. The two are
 *     compared — never silently reconciled — by `nativePluginDetect` in
 *     `@validity.ai/verify-native`.
 *
 * PURE TRANSFORM: the config is copied, not mutated, and every decision is
 * derived from the config passed in. `applyValidityExpoConfig` returns the
 * notices instead of logging them, so the whole behaviour is unit-testable
 * against fixture app configs with no Expo, no device and no native toolchain.
 */
import { VALIDITY_EXTRA_KEY, type ExpoConfigLike, type ValidityExpoStamp } from './expo-config.js';
import { deriveDefaultScheme, discoverSchemes, normalizeScheme } from './scheme.js';
import { PLUGIN_VERSION } from './version.js';

/** Options accepted as the config-plugin's second argument. */
export interface ValidityPluginProps {
  /**
   * Force the scheme the app registers, instead of keeping the one it already
   * declares / deriving one from the slug.
   *
   * This is an ESCAPE HATCH, not the normal path. It is only additive: an
   * app that already declares schemes keeps them and gains this one (appended,
   * never reordered — `Linking.createURL()` uses the first entry, so replacing
   * it would silently repoint every link the app builds at runtime).
   */
  scheme?: string;
}

/**
 * Severity of a {@link ValidityConfigNotice}. Nothing here is ever fatal.
 *
 * `debug` is the "nothing happened" tier and is NOT printed by the default
 * logger: an Expo config is re-evaluated by `expo start`, `expo config`,
 * `expo prebuild` and every `eas build`, so a line that fires on the happy path
 * is a line the user reads a hundred times and then stops reading. `info` is
 * reserved for the cases where the plugin actually changed the native config.
 */
export type ValidityNoticeLevel = 'debug' | 'info' | 'warn';

/** Stable machine-readable identifiers for the plugin's notices. */
export type ValidityNoticeCode =
  /** The app declared no scheme; one was derived from the slug and added. */
  | 'scheme-added'
  /** The app already declared a scheme; it was kept verbatim. */
  | 'scheme-kept'
  /** `props.scheme` was appended to schemes the app already declared. */
  | 'scheme-appended'
  /** `props.scheme` was not a legal URL scheme and had to be coerced. */
  | 'scheme-normalized'
  /** `props.scheme` could not be coerced into a legal URL scheme at all. */
  | 'scheme-invalid'
  /** No scheme, no slug, no name — nothing to derive from. */
  | 'scheme-underivable'
  /** The scheme is `validity-*`, which is the companion app's namespace. */
  | 'scheme-validity-branded'
  /** The plugin was applied twice with two different explicit schemes. */
  | 'reapplied-different-scheme';

/**
 * Something the user should know, surfaced by `withValidity` through
 * `console.warn`/`console.log` and returned verbatim by
 * {@link applyValidityExpoConfig} so tests can assert on it.
 *
 * A config plugin runs inside `expo prebuild` / `expo config`; throwing from
 * one takes the user's build down. Nothing this plugin can detect justifies
 * that, so every finding is a notice.
 */
export interface ValidityConfigNotice {
  level: ValidityNoticeLevel;
  code: ValidityNoticeCode;
  message: string;
}

/** What {@link applyValidityExpoConfig} produced. */
export interface ApplyValidityResult<T extends ExpoConfigLike> {
  /** The transformed config (a copy — the input is never mutated). */
  config: T;
  /** The scheme recorded in the stamp, if one could be established. */
  scheme?: string;
  /** Everything worth telling the user, in the order it was discovered. */
  notices: ValidityConfigNotice[];
}

const PREFIX = '[@validity.ai/verify-plugin-expo]';

/**
 * The pure half of the plugin: config in, config + notices out.
 *
 * Exported (and tested) separately from {@link withValidity} because the only
 * side effect the plugin has is logging, and a pure core means the entire
 * decision table — kept scheme, added scheme, appended scheme, coerced scheme,
 * underivable scheme, double application — is assertable from fixtures.
 */
export function applyValidityExpoConfig<T extends ExpoConfigLike>(
  config: T,
  props?: ValidityPluginProps,
): ApplyValidityResult<T> {
  const notices: ValidityConfigNotice[] = [];
  const discovered = discoverSchemes(config);

  // --- 1. Decide which scheme the app should be stamped with. ----------------
  let requested: string | undefined;
  if (typeof props?.scheme === 'string' && props.scheme.trim()) {
    requested = normalizeScheme(props.scheme);
    if (!requested) {
      notices.push({
        level: 'warn',
        code: 'scheme-invalid',
        message:
          `${PREFIX} scheme "${props.scheme}" is not a usable URL scheme ` +
          '(a scheme must start with a letter and contain only letters, digits, "+", "-" and "."). ' +
          "Falling back to the app's own scheme.",
      });
    } else if (requested !== props.scheme) {
      notices.push({
        level: 'warn',
        code: 'scheme-normalized',
        message:
          `${PREFIX} scheme "${props.scheme}" is not a legal URL scheme; using "${requested}" instead. ` +
          'Set the props.scheme to that value to silence this.',
      });
    }
  }

  // Precedence: an explicit prop, then whatever the app ALREADY declares
  // (expo.scheme first, then the raw iOS/Android registrations), then Expo's
  // own convention of using the slug. The app's existing scheme outranks the
  // derived default by design — this plugin makes an app deep-linkable, it does
  // not rename one that already is.
  const existingPrimary = discovered.all[0];
  const derived = deriveDefaultScheme(config);
  const scheme = requested ?? existingPrimary ?? derived;

  if (!scheme) {
    notices.push({
      level: 'warn',
      code: 'scheme-underivable',
      message:
        `${PREFIX} this app declares no "scheme" and has no "slug"/"name" to derive one from, ` +
        'so it cannot be deep-linked. Add `"scheme": "your-app"` to your Expo config — ' +
        'Validity opens dev-client builds with `<scheme>://expo-development-client/?url=…`.',
    });
  } else if (requested && existingPrimary && requested !== existingPrimary) {
    notices.push({
      level: 'info',
      code: 'scheme-appended',
      message:
        `${PREFIX} appending scheme "${scheme}" — the app already registers ` +
        `"${discovered.all.join('", "')}", and those are kept (Linking.createURL() uses the first).`,
    });
  } else if (existingPrimary) {
    notices.push({
      level: 'debug',
      code: 'scheme-kept',
      message: `${PREFIX} app already registers scheme "${existingPrimary}" — kept as-is.`,
    });
  } else {
    notices.push({
      level: 'info',
      code: 'scheme-added',
      message:
        `${PREFIX} this app declared no URL scheme; adding "${scheme}" (from its slug) ` +
        'so it can be opened by deep link.',
    });
  }

  // A `validity-*` scheme on the USER's app is the exact collision the
  // companion's unique-scheme derivation exists to avoid. Advisory, because it
  // is legal and might be deliberate — but it is never what Validity wants.
  if (scheme && scheme.startsWith('validity-')) {
    notices.push({
      level: 'warn',
      code: 'scheme-validity-branded',
      message:
        `${PREFIX} scheme "${scheme}" is in the "validity-" namespace, which the Validity ` +
        'companion app uses for itself. If both apps end up installed on one device they will ' +
        "both answer this scheme and deep links will route nondeterministically. Use your app's own name.",
    });
  }

  // --- 2. Copy-on-write the scheme into `expo.scheme`. ----------------------
  // `expo prebuild` turns this into the iOS CFBundleURLTypes entry AND the
  // Android intent filter, and `Linking.createURL()` reads it, so it is the one
  // place worth writing. APPEND-ONLY: index 0 is load-bearing at runtime.
  let next: T = config;
  if (scheme && !discovered.fromScheme.includes(scheme)) {
    const merged: string | string[] =
      discovered.fromScheme.length === 0 ? scheme : [...discovered.fromScheme, scheme];
    next = { ...next, scheme: merged };
  }

  // --- 3. Stamp `expo.extra.validity`. -------------------------------------
  const priorStamp = readStamp(config);
  if (
    priorStamp?.scheme &&
    scheme &&
    priorStamp.scheme !== scheme &&
    typeof props?.scheme === 'string'
  ) {
    // The plugin is listed twice with two different explicit schemes. Both are
    // now registered on the app (step 2 is additive), but the stamp can only
    // name one, and later-wins is the predictable rule. Never silent.
    notices.push({
      level: 'warn',
      code: 'reapplied-different-scheme',
      message:
        `${PREFIX} applied more than once with different schemes ("${priorStamp.scheme}" then ` +
        `"${scheme}"). Both are registered; the stamp records "${scheme}". List the plugin once.`,
    });
  }

  const stamp: ValidityExpoStamp = {
    pluginVersion: PLUGIN_VERSION,
    ...(scheme ? { scheme } : {}),
  };
  next = {
    ...next,
    extra: { ...(next.extra ?? {}), [VALIDITY_EXTRA_KEY]: stamp },
  };

  return { config: next, scheme, notices };
}

/** Read a stamp a previous application of this plugin left behind, if any. */
function readStamp(config: ExpoConfigLike): ValidityExpoStamp | undefined {
  const raw = config.extra?.[VALIDITY_EXTRA_KEY];
  if (!raw || typeof raw !== 'object') return undefined;
  const { pluginVersion, scheme } = raw as Record<string, unknown>;
  if (typeof pluginVersion !== 'string') return undefined;
  return { pluginVersion, ...(typeof scheme === 'string' ? { scheme } : {}) };
}

/**
 * Where {@link withValidity} sends its notices. Injectable so the logging
 * behaviour itself is assertable without spying on the global console.
 */
export interface ValidityPluginLogger {
  /** Optional. The default logger has no debug sink — see {@link ValidityNoticeLevel}. */
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
}

const consoleLogger: ValidityPluginLogger = {
  // `console.log` rather than `console.info`: Expo's CLI passes stdout through,
  // and an informational line about a scheme decision is not a warning.
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
};

/**
 * The Expo config plugin. Structurally a `ConfigPlugin<ValidityPluginProps>`
 * from `@expo/config-plugins`, without depending on that package: it is
 * generic in the config type so a typed `app.config.ts` gets its own
 * `ExpoConfig` back rather than this package's widened view of it.
 *
 * Usage (app.json):
 *
 *     { "expo": { "plugins": ["@validity.ai/verify-plugin-expo"] } }
 *
 * Usage with an explicit scheme (app.config.ts):
 *
 *     import { withValidity } from '@validity.ai/verify-plugin-expo';
 *     export default ({ config }) => withValidity(config, { scheme: 'myapp' });
 */
export function withValidity<T extends ExpoConfigLike>(
  config: T,
  props?: ValidityPluginProps,
  logger: ValidityPluginLogger = consoleLogger,
): T {
  const result = applyValidityExpoConfig(config, props);
  for (const notice of result.notices) {
    if (notice.level === 'warn') logger.warn(notice.message);
    else if (notice.level === 'info') logger.info(notice.message);
    else logger.debug?.(notice.message);
  }
  return result.config;
}

export default withValidity;
