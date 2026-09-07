// Web stub for react-native/Libraries/Core/Devtools/getDevServer.
//
// Why this exists — TWO reasons, one now historical, one still load-bearing:
//
// 1. (Subsumed by flow-strip.ts.) The REAL module is Flow-typed react-native
//    *source* (`let _cachedDevServerURL: ?string;` etc.) that esbuild — Vite's
//    dep optimizer — couldn't parse, hard-failing the whole optimize. The
//    flow-strip esbuild plugin now makes RN core PARSE, so that rationale
//    alone no longer requires this stub.
// 2. (Still required — do NOT drop this stub.) The real module imports
//    NativeSourceCode, which calls TurboModuleRegistry.getEnforcing(
//    'SourceCode') at module scope; on web there is no TurboModule binding,
//    so merely importing it throws and red-screens the render. flow-strip
//    only fixes parsing, not that runtime crash.
//
// It's a dev-only helper that reports the Metro packager URL; in a one-shot
// web render there is no Metro server and the returned value is never used.
// Return a static shape matching the real module's `DevServerInfo` contract
// so any consumer that does read it gets a well-formed object instead of a
// crash.
export default function getDevServer() {
  return {
    url: 'http://localhost:8081/',
    fullBundleUrl: null,
    bundleLoadedFromServer: false,
  };
}
