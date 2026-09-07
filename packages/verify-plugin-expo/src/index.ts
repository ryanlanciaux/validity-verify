/**
 * `@validity.ai/verify-plugin-expo` — the Expo config plugin half of Validity's app
 * integration. See README.md for what it does and, more importantly, what it
 * deliberately does not do.
 *
 * The default export is the plugin function, which is what
 * `plugins: ["@validity.ai/verify-plugin-expo"]` resolves to via `app.plugin.js`.
 */
export {
  withValidity,
  applyValidityExpoConfig,
  type ValidityPluginProps,
  type ValidityPluginLogger,
  type ValidityConfigNotice,
  type ValidityNoticeCode,
  type ValidityNoticeLevel,
  type ApplyValidityResult,
} from './with-validity.js';

export {
  discoverSchemes,
  deriveDefaultScheme,
  normalizeScheme,
  isValidScheme,
  type DiscoveredSchemes,
} from './scheme.js';

export {
  VALIDITY_EXTRA_KEY,
  type ExpoConfigLike,
  type ExpoIosConfigLike,
  type ExpoAndroidConfigLike,
  type ValidityExpoStamp,
} from './expo-config.js';

export { PLUGIN_VERSION } from './version.js';

export { withValidity as default } from './with-validity.js';
