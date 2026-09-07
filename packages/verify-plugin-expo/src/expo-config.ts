/**
 * The SLICE of Expo's app config this plugin touches, declared structurally
 * instead of imported from `@expo/config-types`.
 *
 * WHY NOT IMPORT EXPO'S TYPES: this package has zero dependency on the Expo
 * toolchain — it is a pure `(config) => config` transform and imports nothing
 * from `@expo/config-plugins`. Declaring it even as a PEER is not free: pnpm
 * auto-installs peers, and a declared `expo`/`@expo/config-plugins` peer pulls
 * expo, react-native and the entire `@react-native/babel-preset` tree (~430
 * packages, measured) into this monorepo's lockfile purely to name four
 * optional fields. Instead the fields are declared here, WIDER than Expo's
 * (every property optional), so an Expo `ExpoConfig` is structurally assignable
 * to {@link ExpoConfigLike} and the plugin type-checks in a user's
 * `app.config.ts` without adaptation.
 *
 * The trade is explicit: if Expo ever renames `scheme` / `ios.infoPlist` /
 * `android.intentFilters` / `extra`, this file is the one place to update, and
 * the plugin's tests (which assert against fixture app configs shaped exactly
 * like Expo's docs) are what would catch it.
 */

/** iOS half of the app config. Only `infoPlist` is read (never written). */
export interface ExpoIosConfigLike {
  /**
   * Raw `Info.plist` entries merged by `expo prebuild`. Read as EVIDENCE of an
   * existing URL-scheme registration — an app that hand-rolls
   * `CFBundleURLTypes` instead of using `expo.scheme` already owns a scheme and
   * must not have a second one invented for it.
   */
  infoPlist?: Record<string, unknown>;
}

/** Android half of the app config. Only `intentFilters` is read (never written). */
export interface ExpoAndroidConfigLike {
  /**
   * Raw `<intent-filter>` entries merged by `expo prebuild`. Read as EVIDENCE
   * of an existing URL-scheme registration, exactly like `ios.infoPlist` above.
   */
  intentFilters?: unknown[];
}

/**
 * The app config as this plugin sees it. Every field optional on purpose: the
 * plugin runs against configs from `app.json`, `app.config.js` and
 * `app.config.ts`, at any Expo SDK, and must not crash on a shape it does not
 * recognise.
 */
export interface ExpoConfigLike {
  /** Display name. Fallback source for the derived scheme when there is no slug. */
  name?: string;
  /** URL-safe app identifier. The conventional source of an Expo app's scheme. */
  slug?: string;
  /**
   * The app's custom URL scheme(s). `expo prebuild` compiles these into iOS
   * `CFBundleURLTypes` and an Android `<intent-filter>`, and `expo-linking`'s
   * `Linking.createURL()` uses the FIRST one — which is why this plugin only
   * ever APPENDS here and never reorders or replaces.
   */
  scheme?: string | string[];
  ios?: ExpoIosConfigLike;
  android?: ExpoAndroidConfigLike;
  /** Arbitrary values surfaced to the app at runtime. Home of the Validity stamp. */
  extra?: Record<string, unknown>;
}

/**
 * The stamp this plugin writes to `expo.extra.validity`. It is the ONLY proof
 * that the plugin actually ran: a plugin merely *listed* in `expo.plugins` is
 * an assertion, whereas a stamp in the RESOLVED config (`expo config --json`)
 * is an observation. `native-plugin-detect.ts` in `@validity.ai/verify-native` reads
 * exactly this shape.
 *
 * ADD-ONLY CONTRACT: fields may be added in later versions, never removed or
 * repurposed, so an older reader keeps working against a newer stamp.
 */
export interface ValidityExpoStamp {
  /** The version of `@validity.ai/verify-plugin-expo` that produced this stamp. */
  pluginVersion: string;
  /**
   * The scheme the plugin guaranteed the app owns. Absent only in the
   * pathological case where the config had no scheme AND no slug/name to derive
   * one from (the plugin warns and stamps itself anyway, so the readiness
   * checklist can say "plugin ran, but could not establish a scheme").
   */
  scheme?: string;
}

/** The `extra` key the stamp lives under. */
export const VALIDITY_EXTRA_KEY = 'validity';
