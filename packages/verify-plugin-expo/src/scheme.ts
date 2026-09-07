/**
 * URL-scheme discovery, normalisation and derivation for the Validity Expo
 * plugin.
 *
 * WHY THE PLUGIN CARES ABOUT SCHEMES AT ALL
 *
 * Validity drives a real device through deep links. Two DIFFERENT apps are
 * involved and they must never share a scheme:
 *
 *   1. The Validity COMPANION app (`.validity/native-app/`, bundle
 *      `ai.validity.playground`) — the component playground. It derives its own
 *      unique scheme (`defaultCompanionScheme` in `@validity.ai/verify-native`) precisely
 *      so it cannot collide with anything the user has installed. This plugin
 *      NEVER touches it, and never registers a Validity-branded scheme on the
 *      user's app: two installed apps answering one scheme makes iOS resolve
 *      `scheme://…` nondeterministically, and the capture then screenshots the
 *      WRONG app while still exiting 0.
 *
 *   2. The USER's own app — driven directly for `.ad` device journeys and for
 *      dev-client opens (`<their-scheme>://expo-development-client/?url=…`).
 *      That control link is only routable if the app registers SOME scheme of
 *      its own. An Expo app with no `scheme` cannot be deep-linked at all.
 *
 * So the plugin's job here is narrow and conservative: make sure the user's app
 * owns A scheme — ITS OWN, not ours. If the config already declares one (by any
 * of the three mechanisms below), that one is kept verbatim and merely recorded
 * in the stamp. Only a config that declares none gets one added, and the value
 * added is Expo's own convention: the app slug.
 */

/**
 * RFC 3986 scheme grammar: `ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )`.
 * Android's `<data android:scheme>` and iOS's `CFBundleURLSchemes` both follow
 * it, and Expo rejects violations at prebuild time.
 */
const VALID_SCHEME = /^[a-z][a-z0-9+\-.]*$/;

/** Is this a URL scheme both platforms will accept? */
export function isValidScheme(value: string): boolean {
  return VALID_SCHEME.test(value);
}

/**
 * Coerce an arbitrary string into a legal, lowercase URL scheme, or `undefined`
 * when nothing usable survives.
 *
 * Deliberately LOSSY and deliberately deterministic: `My App!` → `my-app`, the
 * same slugging shape `defaultCompanionScheme` uses on the companion side, so
 * the two halves of the system agree on what a slug looks like. A scheme that
 * would start with a digit (a slug like `1password`) gets an `app-` prefix
 * rather than being dropped — a leading digit is the one violation that is
 * mechanically repairable without guessing at intent.
 */
export function normalizeScheme(value: string): string | undefined {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9+\-.]+/g, '-')
    .replace(/^[-+.]+|[-+.]+$/g, '');
  if (!slug) return undefined;
  const withLetterStart = /^[a-z]/.test(slug) ? slug : `app-${slug}`;
  return isValidScheme(withLetterStart) ? withLetterStart : undefined;
}

/**
 * Where an app can already be declaring a URL scheme. Kept as three separate
 * lists (rather than one merged set) so a caller — and the plugin's warnings —
 * can say WHICH mechanism the app used, and so a config that registers a scheme
 * on only one platform is visible as exactly that.
 */
export interface DiscoveredSchemes {
  /** From `expo.scheme` (string or array). The canonical, cross-platform form. */
  fromScheme: string[];
  /** From `ios.infoPlist.CFBundleURLTypes[].CFBundleURLSchemes[]`. */
  fromIos: string[];
  /** From `android.intentFilters[].data[].scheme`. */
  fromAndroid: string[];
  /**
   * Every discovered scheme, de-duplicated, in the order
   * `expo.scheme` → iOS → Android. `all[0]` is the app's PRIMARY scheme: the one
   * `Linking.createURL()` produces and the one a dev-client control link should
   * use.
   */
  all: string[];
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function stringsFrom(value: unknown): string[] {
  return asArray(value).filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/**
 * Read every URL scheme the config already declares, by all three mechanisms.
 *
 * The iOS/Android reads exist because `expo.scheme` is NOT the only way to
 * register a scheme: an app that needs several URL types, or that migrated from
 * a bare React Native project, commonly writes `ios.infoPlist.CFBundleURLTypes`
 * / `android.intentFilters` by hand. Treating such an app as "has no scheme"
 * and helpfully adding one would be a speculative rewrite of working config —
 * exactly what this plugin must not do.
 *
 * Tolerant by construction: any field with an unexpected shape contributes
 * nothing instead of throwing. A config plugin that crashes takes the user's
 * `expo prebuild` down with it.
 */
export function discoverSchemes(config: {
  scheme?: string | string[];
  ios?: { infoPlist?: Record<string, unknown> };
  android?: { intentFilters?: unknown[] };
}): DiscoveredSchemes {
  const fromScheme = stringsFrom(config.scheme);

  const fromIos: string[] = [];
  for (const entry of asArray(config.ios?.infoPlist?.['CFBundleURLTypes'])) {
    if (!entry || typeof entry !== 'object') continue;
    fromIos.push(...stringsFrom((entry as Record<string, unknown>)['CFBundleURLSchemes']));
  }

  const fromAndroid: string[] = [];
  for (const filter of asArray(config.android?.intentFilters)) {
    if (!filter || typeof filter !== 'object') continue;
    // `data` is documented as an object OR an array of objects.
    for (const data of asArray((filter as Record<string, unknown>)['data'])) {
      if (!data || typeof data !== 'object') continue;
      const scheme = (data as Record<string, unknown>)['scheme'];
      if (typeof scheme === 'string' && scheme) fromAndroid.push(scheme);
    }
  }

  const all = [...new Set([...fromScheme, ...fromIos, ...fromAndroid])];
  return { fromScheme, fromIos, fromAndroid, all };
}

/**
 * The scheme to add when the app declares none: Expo's own convention, the app
 * slug (this is what `npx create-expo-app` writes and what the Expo docs tell
 * you to use). Falls back to the display name, then to nothing at all.
 *
 * Returning `undefined` rather than inventing a name is the point: a config with
 * neither `slug` nor `name` is not an app config we understand, and guessing a
 * scheme for it would bake an arbitrary string into a native binary.
 */
export function deriveDefaultScheme(config: { slug?: string; name?: string }): string | undefined {
  for (const candidate of [config.slug, config.name]) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const normalized = normalizeScheme(candidate);
    if (normalized) return normalized;
  }
  return undefined;
}
