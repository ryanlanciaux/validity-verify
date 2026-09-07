/**
 * next/link stub — renders <a href> instead of Next's router Link.
 * Clicking the link does NOT navigate (Validity's sandbox has no router).
 * Preserves href, children, passHref, target, rel so a real <a> renders
 * with the right attributes.
 */
import React from 'react';

export default function Link({
  href,
  children,
  prefetch: _prefetch,
  replace: _replace,
  shallow: _shallow,
  passHref: _passHref,
  scroll: _scroll,
  locale: _locale,
  ...rest
}) {
  return React.createElement('a', { href: href ?? '#', ...rest }, children);
}
