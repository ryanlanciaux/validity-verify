import type { ReactNode } from 'react';
import '../src/index.css';

/**
 * Wrapper applied around every component Validity renders in isolation.
 * Mirror the providers your real <App> uses (router, theme, query, auth, etc.).
 *
 * Validity injects mock auth via the `__VALIDITY_MOCKS__` global if configured;
 * forward any provider context your components need.
 */
export default function Wrapper({ children }: { children: ReactNode }) {
  return <div className="layout">{children}</div>;
}
