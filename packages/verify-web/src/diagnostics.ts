/**
 * Per-render diagnostics: console errors, uncaught page errors, and failed
 * (4xx/5xx) network responses. Captured by listening on the Playwright Page
 * during a render and snapshot-read just before the page is closed.
 *
 * These signals close Validity's most embarrassing failure mode — an agent
 * scoring "looks fine" against a screenshot while React is throwing in the
 * console. The screenshot alone hides those errors; surfacing them to the
 * agent (and to the report) makes them load-bearing in the verdict.
 *
 * Listeners are deliberately additive: failures here never short-circuit
 * the capture. A console.error that fires post-screenshot is still useful
 * signal, but the capture pipeline must not depend on it.
 */
import type { ConsoleMessage, Page, Request, Response } from 'playwright';

/**
 * A single `console.error` entry. The shape mirrors what Playwright surfaces
 * via `ConsoleMessage`, minus the JSHandle args (which we'd have to serialize
 * and which are rarely useful for scoring).
 */
export interface ConsoleErrorEntry {
  /** Joined message text (Playwright already stringifies args for us). */
  text: string;
  /** Source URL of the console call site, when Playwright can resolve it. */
  url?: string;
  /** Line number in the source, 1-based. Undefined when unknown. */
  lineNumber?: number;
}

/** Uncaught exception / unhandled promise rejection that escaped React. */
export interface PageErrorEntry {
  message: string;
  /** Stack trace if Playwright was able to surface one. */
  stack?: string;
}

/**
 * A 4xx / 5xx response. Filtered to ignore framework chatter (HMR, assets).
 *
 * Caveat: in **isolation mode**, fetch interception happens at the
 * JavaScript layer via `@mswjs/interceptors` patching `globalThis.fetch`.
 * Those synthetic responses do NOT fire Playwright's `page.on('response')`
 * because no real HTTP response ever exists — the interceptor returns a
 * `Response` object directly inside the page's JS realm. So this listener
 * only catches requests that BYPASS MSW (e.g., asset loads — which we
 * filter out as framework chatter). Isolation-mode 4xx/5xx mocks surface
 * via screenshot content and `unmatchedUrls` instead.
 *
 * In **URL mode** the request flow goes Playwright → `page.route('**\/*')`
 * → either user handler or real dev server → `page.on('response')` fires.
 * URL mode is where this signal is genuinely useful.
 */
export interface NetworkErrorEntry {
  method: string;
  url: string;
  status: number;
  statusText?: string;
}

export interface Diagnostics {
  consoleErrors: ConsoleErrorEntry[];
  pageErrors: PageErrorEntry[];
  networkErrors: NetworkErrorEntry[];
}

export interface DiagnosticsHandle {
  /** Capture the current state. Safe to call multiple times. */
  snapshot(): Diagnostics;
  /**
   * True (uncapped) count of `console.error`s seen since attach. The
   * `snapshot().consoleErrors` array is capped at {@link MAX_ENTRIES_PER_TYPE}
   * for response size, so its length under-reports; this counter is what the
   * `expect.console` gate must seed from so mount/render-time errors (which
   * happen before the per-criterion executor installs its own listener) are
   * not invisible to the check.
   */
  consoleErrorCount(): number;
}

/**
 * Cap per-array so a runaway interval (an axios retry storm, a useEffect that
 * logs on every render, a 404 polled forever) can't blow up the tool
 * response. We keep the FIRST N entries — the early ones are usually the
 * proximate cause; later ones are aftermath.
 */
const MAX_ENTRIES_PER_TYPE = 25;

/**
 * Matches Vite / Next / other dev-server framework chatter: HMR pings, the
 * internal module-graph endpoints, source maps, asset bundles. These show up
 * as 404s during normal hot-reload churn and are not user-facing failures —
 * filtering them keeps the signal-to-noise of `networkErrors` usable.
 */
const FRAMEWORK_PATH_PREFIXES = [
  '/_next/',
  '/__next/',
  '/_nuxt/',
  '/@vite/',
  '/@id/',
  '/@fs/',
  '/@react-refresh',
  '/node_modules/',
  '/.well-known/',
  '/__validity/',
];

const ASSET_EXTENSIONS =
  /\.(?:js|mjs|cjs|css|map|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|otf|eot|wasm|mp4|webm|mp3|wav)(?:\?|$)/i;

function isFrameworkChatter(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  if (ASSET_EXTENSIONS.test(path)) return true;
  for (const prefix of FRAMEWORK_PATH_PREFIXES) {
    if (path.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Attach the three diagnostic listeners to a freshly-created Page. Returns a
 * handle whose `snapshot()` reads the current buffers. Listeners stay
 * attached for the lifetime of the page — Playwright tears them down when
 * the page closes.
 */
export function attachDiagnostics(page: Page): DiagnosticsHandle {
  const consoleErrors: ConsoleErrorEntry[] = [];
  const pageErrors: PageErrorEntry[] = [];
  const networkErrors: NetworkErrorEntry[] = [];
  // Uncapped tally, distinct from the capped `consoleErrors` array above.
  let consoleErrorTotal = 0;

  const pushCapped = <T>(arr: T[], value: T): void => {
    if (arr.length < MAX_ENTRIES_PER_TYPE) arr.push(value);
  };

  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() !== 'error') return;
    consoleErrorTotal += 1;
    const loc = msg.location();
    pushCapped(consoleErrors, {
      text: msg.text(),
      url: loc?.url || undefined,
      lineNumber: typeof loc?.lineNumber === 'number' ? loc.lineNumber + 1 : undefined,
    });
  });

  page.on('pageerror', (err: Error) => {
    pushCapped(pageErrors, {
      message: err.message,
      stack: err.stack,
    });
  });

  page.on('response', (res: Response) => {
    const status = res.status();
    if (status < 400) return;
    const request: Request = res.request();
    const url = res.url();
    if (isFrameworkChatter(url)) return;
    pushCapped(networkErrors, {
      method: request.method(),
      url,
      status,
      statusText: res.statusText() || undefined,
    });
  });

  return {
    snapshot(): Diagnostics {
      // Return shallow copies so callers can mutate without poisoning the
      // listener's buffers (and so a second snapshot reflects fresh state).
      return {
        consoleErrors: [...consoleErrors],
        pageErrors: [...pageErrors],
        networkErrors: [...networkErrors],
      };
    },
    consoleErrorCount(): number {
      return consoleErrorTotal;
    },
  };
}

/** Whether a snapshot contains anything worth surfacing to the agent. */
export function hasDiagnostics(d: Diagnostics): boolean {
  return d.consoleErrors.length > 0 || d.pageErrors.length > 0 || d.networkErrors.length > 0;
}

/**
 * Format a diagnostics snapshot as a single human-readable text block for
 * the MCP verify tool result. Matches the existing tool-output style
 * (`Unmatched fetch(es)…` blocks): a leading header, bulleted entries, and
 * an actionable hint when relevant.
 *
 * Returns `undefined` when the snapshot is empty — callers can skip the
 * content block entirely instead of emitting an empty section.
 */
export function formatDiagnosticsBlock(d: Diagnostics, scenarioLabel: string): string | undefined {
  if (!hasDiagnostics(d)) return undefined;
  const lines: string[] = [`Diagnostics under '${scenarioLabel}':`];

  if (d.pageErrors.length > 0) {
    lines.push(`  Uncaught errors (${d.pageErrors.length}):`);
    for (const e of d.pageErrors) {
      lines.push(`    • ${e.message}`);
    }
  }
  if (d.consoleErrors.length > 0) {
    lines.push(`  Console errors (${d.consoleErrors.length}):`);
    for (const e of d.consoleErrors) {
      const loc = e.url ? ` (${e.url}${e.lineNumber ? `:${e.lineNumber}` : ''})` : '';
      lines.push(`    • ${e.text}${loc}`);
    }
  }
  if (d.networkErrors.length > 0) {
    lines.push(`  Failed network responses (${d.networkErrors.length}):`);
    for (const e of d.networkErrors) {
      const st = e.statusText ? ` ${e.statusText}` : '';
      lines.push(`    • ${e.method} ${e.url} → ${e.status}${st}`);
    }
  }

  lines.push(
    '  → These were captured during render. If a screenshot looks fine but errors fired, the component may be silently broken — investigate before scoring as pass.',
  );

  return lines.join('\n');
}
