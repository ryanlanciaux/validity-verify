// Expo's plugin resolver (`@expo/config-plugins`' `resolvePluginForModule`)
// looks for `<package>/app.plugin.js` BEFORE falling back to `main`, so this
// file is what makes `"plugins": ["@validity.ai/verify-plugin-expo"]` work in app.json /
// app.config.js. It must be plain CommonJS and must export the plugin function
// itself (Expo's `resolveConfigPluginExport` unwraps a `.default` and then
// asserts the result is a function).
//
// Deliberately a two-line shim: all logic lives in TypeScript under src/ and
// is compiled to CJS in dist/ (see tsconfig.json for why this package is CJS).
const { withValidity } = require('./dist/index.js');

module.exports = withValidity;
// Interop: some Expo versions read `.default` first. Pointing it back at the
// same function makes both resolution orders land on the same plugin.
module.exports.default = withValidity;
