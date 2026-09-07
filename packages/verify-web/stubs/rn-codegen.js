// Web stub for react-native/Libraries/Utilities/codegenNativeComponent.
//
// Why this exists: RN web libraries (e.g. react-native-safe-area-context) import
// this from their generated native "specs" even in their web build:
//   import codegenNativeComponent from 'react-native/Libraries/Utilities/codegenNativeComponent';
//   export default codegenNativeComponent('RNCSafeAreaView');
// The REAL module is Flow-typed react-native *source* that transitively pulls in
// RN core (LogBox, AppContainer, Devtools) — none of which esbuild (Vite's dep
// optimizer) can parse, so pre-bundling the consuming library hard-fails. On web
// the native view is never actually instantiated (libraries branch on Platform /
// fall back to JS implementations), so a passthrough component is enough to let
// the bundle build and the web code path run.
import { createElement, forwardRef } from 'react';

const PassthroughNativeComponent = forwardRef(function PassthroughNativeComponent(props, ref) {
  const { children, style } = props ?? {};
  return createElement('div', { ref, style }, children);
});
PassthroughNativeComponent.displayName = 'CodegenNativeComponentStub';

export default function codegenNativeComponent() {
  return PassthroughNativeComponent;
}
