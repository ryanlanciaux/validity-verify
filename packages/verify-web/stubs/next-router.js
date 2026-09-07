/**
 * next/router stub (Pages Router) — mock useRouter returning no-op methods.
 * Components that read `useRouter()` for `push`/`replace`/`back`/`reload`/
 * `prefetch` render without throwing; calling any of them is a no-op (the
 * sandbox has no router). `route`, `pathname`, `query`, `asPath` return
 * sensible defaults.
 */
const noop = () => {};
const mockRouter = {
  route: '/',
  pathname: '/',
  query: {},
  asPath: '/',
  basePath: '',
  locale: undefined,
  locales: undefined,
  defaultLocale: 'en',
  isReady: true,
  isPreview: false,
  isFallback: false,
  push: noop,
  replace: noop,
  back: noop,
  reload: noop,
  prefetch: async () => {},
  beforePopState: noop,
  events: { on: noop, off: noop, emit: noop },
};

export function useRouter() {
  return mockRouter;
}

export default { useRouter };
