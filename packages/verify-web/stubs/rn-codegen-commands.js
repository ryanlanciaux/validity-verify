// Web stub for react-native/Libraries/Utilities/codegenNativeCommands.
//
// Companion to rn-codegen.js. Libraries with imperative native commands (e.g.
// scrollToIndex on a Fabric component) import this and call it at module load:
//   import codegenNativeCommands from 'react-native/Libraries/Utilities/codegenNativeCommands';
//   export default codegenNativeCommands({ supportedCommands: [...] });
// The real module is Flow-typed RN source (same esbuild parse problem as
// codegenNativeComponent). On web the commands target native view refs that
// never exist, so a no-op command map is the correct shim.
export default function codegenNativeCommands() {
  return {};
}
