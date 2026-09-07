/**
 * next/navigation stub (App Router) — mock useRouter, usePathname,
 * useSearchParams, useParams, redirect, notFound. All navigation is a
 * no-op; hooks return sensible defaults so client components that read the
 * current route render without throwing.
 */
const noop = () => {};
const mockRouter = {
  push: noop,
  replace: noop,
  back: noop,
  forward: noop,
  refresh: noop,
  prefetch: async () => {},
};

export function useRouter() {
  return mockRouter;
}

export function usePathname() {
  return '/';
}

export function useSearchParams() {
  return new URLSearchParams();
}

export function useParams() {
  return {};
}

export function redirect() {
  // No-op — the sandbox has no router to redirect through.
}

export function notFound() {
  // No-op — calling notFound() in the sandbox doesn't render the 404 page;
  // it just returns. A component that legitimately calls notFound() should
  // surface its "not found" state another way for the verify to see it.
}

export default { useRouter, usePathname, useSearchParams, useParams, redirect, notFound };
