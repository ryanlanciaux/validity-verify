// Passthrough stub for react-native ecosystem packages with no
// web build (react-native-gesture-handler, older react-native-svg,
// react-native-reanimated when /mock isn't available).
//
// We render every "component" as a React fragment / passthrough <div>
// so the rest of the tree mounts without throwing. Native-only behavior
// (gestures, worklets, native modules) is NOT exercised — that's Phase
// 2 (real-device runs).
//
// CommonJS-shaped (module.exports + named exports) so it works as a
// drop-in replacement for both ESM and CJS consumers. Vite handles
// the ESM/CJS interop.
import { createElement, forwardRef } from 'react';
// In the expo-web sandbox the bare `react-native` specifier is aliased to
// react-native-web, so this resolves to RNW's <View>. We render passthroughs
// as a <View> (not a raw <div>) so RN-style props — style ARRAYS, numeric
// lengths, transforms — are normalized by RNW instead of being handed straight
// to a DOM node (a raw div throws "Failed to set an indexed property [0] on
// CSSStyleDeclaration" the moment it receives an array style, which RN scroll
// containers like KeyboardAwareScrollView pass).
import { View } from 'react-native';

function passthrough(displayName) {
  const Comp = forwardRef(function Comp(props, ref) {
    const { children, style, ...rest } = props ?? {};
    // Drop RN-only / scroll-container props RNW's View doesn't understand so
    // they don't warn or leak onto the DOM node.
    delete rest.collapsable;
    delete rest.contentContainerStyle;
    delete rest.keyboardShouldPersistTaps;
    delete rest.showsVerticalScrollIndicator;
    delete rest.showsHorizontalScrollIndicator;
    return createElement(View, { ref, style, ...rest }, children);
  });
  Comp.displayName = displayName;
  return Comp;
}

// Frequently-imported names — list explicitly so destructuring imports
// (`import { GestureHandlerRootView } from 'react-native-gesture-handler'`)
// resolve. Anything not listed falls through to a default export `Proxy`
// (see below) that returns a passthrough for any property access.
export const GestureHandlerRootView = passthrough('GestureHandlerRootView');
export const PanGestureHandler = passthrough('PanGestureHandler');
export const TapGestureHandler = passthrough('TapGestureHandler');
export const LongPressGestureHandler = passthrough('LongPressGestureHandler');
export const Swipeable = passthrough('Swipeable');
export const DrawerLayout = passthrough('DrawerLayout');
export const ScrollView = passthrough('ScrollView');
export const FlatList = passthrough('FlatList');

// react-native-svg shapes
export const Svg = passthrough('Svg');
export const Circle = passthrough('Circle');
export const Rect = passthrough('Rect');
export const Path = passthrough('Path');
export const G = passthrough('G');
export const Text = passthrough('SvgText');
export const Line = passthrough('Line');
export const Polygon = passthrough('Polygon');
export const Polyline = passthrough('Polyline');
export const Ellipse = passthrough('Ellipse');
export const Defs = passthrough('Defs');
export const LinearGradient = passthrough('LinearGradient');
export const RadialGradient = passthrough('RadialGradient');
export const Stop = passthrough('Stop');

// react-native-keyboard-controller shapes. Its real build drives
// `useAnimatedScrollHandler` (reanimated worklets) which throw in the
// esbuild sandbox — so we pass everything through. Components render as
// plain containers; hooks return inert reanimated-shaped values so the
// screens that consume them (Ignite's `<Screen>`) mount without crashing.
export const KeyboardProvider = passthrough('KeyboardProvider');
export const KeyboardAwareScrollView = passthrough('KeyboardAwareScrollView');
export const KeyboardAvoidingView = passthrough('KeyboardAvoidingView');
export const KeyboardStickyView = passthrough('KeyboardStickyView');
export const KeyboardGestureArea = passthrough('KeyboardGestureArea');
export const OverKeyboardView = passthrough('OverKeyboardView');
export const KeyboardExtender = passthrough('KeyboardExtender');
export const KeyboardBackgroundView = passthrough('KeyboardBackgroundView');
export const KeyboardControllerView = passthrough('KeyboardControllerView');
const noopSharedValue = { value: 0 };
export const useResizeMode = () => {};
export const useKeyboardAnimation = () => ({ height: noopSharedValue, progress: noopSharedValue });
export const useReanimatedKeyboardAnimation = () => ({
  height: noopSharedValue,
  progress: noopSharedValue,
});
export const useGenericKeyboardHandler = () => {};
export const useKeyboardHandler = () => {};
export const useFocusedInputHandler = () => {};
export const useKeyboardController = () => ({ enabled: false, setEnabled: () => {} });
export const useReanimatedFocusedInput = () => ({ input: { value: null } });
export const useKeyboardContext = () => ({});
export const useAnimatedKeyboard = () => ({ height: noopSharedValue, state: noopSharedValue });
export const useKeyboardState = () => ({
  isVisible: false,
  height: 0,
  duration: 0,
  timestamp: 0,
  target: -1,
  type: 'default',
  appearance: 'default',
});
export const KeyboardController = {
  setInputMode: () => {},
  setDefaultMode: () => {},
  dismiss: () => Promise.resolve(),
  setFocusTo: () => {},
  isVisible: () => false,
  state: () => null,
};
const makeEmitter = () => ({
  addListener: () => ({ remove: () => {} }),
  removeListeners: () => {},
});
export const KeyboardEvents = makeEmitter();
export const FocusedInputEvents = makeEmitter();
export const WindowDimensionsEvents = makeEmitter();
export const KeyboardState = { UNKNOWN: 0, CLOSING: 1, CLOSED: 2, OPENING: 3, OPEN: 4 };

// Reanimated shapes — when /mock isn't available we land here.
export const useAnimatedStyle = () => ({});
export const useSharedValue = (initial) => ({ value: initial });
export const useDerivedValue = (factory) => ({ value: factory() });
export const withTiming = (toValue) => toValue;
export const withSpring = (toValue) => toValue;
export const withDelay = (_delay, value) => value;
export const runOnJS = (fn) => fn;
export const runOnUI = (fn) => fn;
const ReanimatedAnimated = {
  View: passthrough('Animated.View'),
  Text: passthrough('Animated.Text'),
  Image: passthrough('Animated.Image'),
  ScrollView: passthrough('Animated.ScrollView'),
  createAnimatedComponent: (Component) => Component,
};

// Default export — Proxy that returns a passthrough for any unknown
// property access. Catches `import Foo from 'react-native-...'` and
// then `<Foo.Whatever />`.
const fallbackDefault = new Proxy(
  { ...ReanimatedAnimated, default: ReanimatedAnimated },
  {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'symbol') return target[prop];
      // Return a fresh passthrough so the next `.Foo` doesn't share
      // displayName with the previous one.
      return passthrough(String(prop));
    },
  },
);
export default fallbackDefault;
