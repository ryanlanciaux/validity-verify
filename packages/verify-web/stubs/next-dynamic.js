/**
 * next/dynamic stub — renders the component eagerly (no lazy loading, no
 * SSR/CSR split). Validity's sandbox is a CSR-only Vite environment, so
 * dynamic imports are pointless; we just resolve the component directly.
 */
import React from 'react';

export default function dynamic(dynamicImportOrComponent, options) {
  // next/dynamic accepts either a () => import('...') or a direct component.
  // We need a synchronous component to render, so we resolve eagerly.
  const DynamicComponent = React.lazy(() =>
    Promise.resolve(
      typeof dynamicImportOrComponent === 'function'
        ? Promise.resolve(dynamicImportOrComponent()).then((m) => m.default ?? m)
        : dynamicImportOrComponent,
    ).then((c) => ({ default: c })),
  );
  return function DynamicWrapper(props) {
    return React.createElement(
      React.Suspense,
      { fallback: options?.loading ? React.createElement(options.loading) : null },
      React.createElement(DynamicComponent, props),
    );
  };
}
