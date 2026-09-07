/**
 * Axe-core a11y pass run inside Validity's capture pipeline.
 *
 * Runs AFTER the play function but BEFORE the screenshot so that
 *   1. Interaction states (open menu, focused input, submitted form) are
 *      analyzed in the same shape the screenshot captures, and
 *   2. Per-rule failures are deterministically ordered to the screenshot's
 *      DOM — if a user toggles to "after play", the violations match.
 *
 * Failure mode contract: a11y is observational signal, not a gate. Any
 * exception thrown by axe (Page disposed mid-analyze, axe injection fails on
 * a strange CSP, etc.) is swallowed — the capture continues and the
 * `a11yViolations` array stays empty.
 */
import type { Page } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import type { A11yViolation } from '@validity.ai/verify-spec';

/** Severity floor knob. `off` short-circuits before we even build the axe runner. */
export type A11ySeverity = 'serious' | 'critical' | 'off';

/**
 * Map config's severity floor → the set of axe impact levels to keep. Axe's
 * impact strings are 'minor' | 'moderate' | 'serious' | 'critical'. We
 * deliberately drop `minor` and `moderate` by default — they're aspirational
 * noise (e.g. "consider adding a `lang` attribute") for a verify run.
 */
function impactsToKeep(severity: A11ySeverity): Set<string> {
  if (severity === 'critical') return new Set(['critical']);
  return new Set(['serious', 'critical']);
}

const MAX_VIOLATIONS = 50;
/**
 * Per-violation cap on node evidence. A rule like `color-contrast` can flag
 * hundreds of nodes; persisting all of them would bloat run-meta and the
 * agent's tool response. The first N are enough to locate and fix the
 * pattern — the `nodes` count still reports the full extent.
 */
const MAX_NODE_DETAILS = 5;

/**
 * Structural slice of axe's `NodeResult` — only the fields `toNodeDetails`
 * reads. Kept local (not imported from axe-core) so the normalization stays
 * decoupled from axe's exact export surface and survives a type-only review.
 * `target` is axe's `UnlabelledFrameSelector`: an array whose entries are a
 * CSS selector string or, for shadow-DOM crossings, a `string[]`.
 */
interface AxeNodeSlice {
  target: (string | string[])[];
  html?: string;
  failureSummary?: string;
}
/** Truncation budgets for the per-node evidence slice (append `…` when cut). */
const MAX_NODE_TARGET = 200;
const MAX_NODE_HTML = 160;
const MAX_NODE_SUMMARY = 200;

/**
 * Flatten an axe node `target` to a single readable selector string. Axe
 * targets are arrays of CSS selectors describing the path to the node; each
 * entry is normally a string but may itself be an array for shadow-DOM
 * crossings (e.g. `['iframe', ['#shadow-root', 'button']]`). We join the
 * outer path with a space and any inner arrays with a space too, yielding one
 * stable, grep-able selector string per node.
 */
function flattenTarget(target: (string | string[])[]): string {
  // axe is an external source. A node with a missing / non-array `target`
  // would otherwise throw inside `.map`, and runAxe's broad catch would then
  // discard EVERY violation for the render — silently hiding real diagnostics.
  // Coerce to an empty selector instead so the sibling nodes still survive.
  if (!Array.isArray(target)) return '';
  return target.map((part) => (Array.isArray(part) ? part.join(' ') : part)).join(' ');
}

/** Truncate to `max` chars and append `…` when the original was longer. */
function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Build the bounded per-violation evidence slice: first N nodes, each with a
 * flattened selector (≤200 chars), trimmed HTML snippet (≤160 chars), and
 * trimmed axe failure summary (≤200 chars). Returns `undefined` when axe
 * produced no node entries (kept absent so old run-meta shapes stay back-compat
 * on read). Exported for unit-test coverage of the normalization slice.
 */
export function toNodeDetails(nodes: AxeNodeSlice[]): A11yViolation['nodeDetails'] | undefined {
  if (nodes.length === 0) return undefined;
  return nodes.slice(0, MAX_NODE_DETAILS).map((n) => {
    const detail: { target: string; html?: string; failureSummary?: string } = {
      // Bound the selector too — a deep or shadow-DOM `target` chain is
      // otherwise unbounded and would bloat run-meta / the agent tool response
      // despite the html + summary budgets right below it.
      target: truncate(flattenTarget(n.target), MAX_NODE_TARGET),
    };
    if (n.html) detail.html = truncate(n.html, MAX_NODE_HTML);
    if (n.failureSummary) detail.failureSummary = truncate(n.failureSummary, MAX_NODE_SUMMARY);
    return detail;
  });
}

/**
 * Run axe against the live page, filter to the configured severity floor,
 * and return the violations. Returns an empty array on any error or when
 * `severity === 'off'`.
 */
export async function runAxe(page: Page, severity: A11ySeverity): Promise<A11yViolation[]> {
  if (severity === 'off') return [];

  try {
    const builder = new AxeBuilder({ page });
    const results = await builder.analyze();
    const keep = impactsToKeep(severity);
    const out: A11yViolation[] = [];
    for (const v of results.violations) {
      const impact = (v.impact ?? 'minor') as A11yViolation['impact'];
      if (!keep.has(impact)) continue;
      const nodeDetails = toNodeDetails(v.nodes);
      out.push({
        id: v.id,
        impact,
        description: v.description,
        helpUrl: v.helpUrl,
        nodes: v.nodes.length,
        ...(nodeDetails ? { nodeDetails } : {}),
      });
      if (out.length >= MAX_VIOLATIONS) break;
    }
    return out;
  } catch {
    // A11y must never break a capture.
    return [];
  }
}

/**
 * Format the violations as a human-readable text block for the verify
 * tool result. Matches the diagnostics block style so the agent's eye
 * reads them together. Returns undefined when there's nothing to surface.
 */
export function formatA11yBlock(
  violations: A11yViolation[] | undefined,
  scenarioLabel: string,
): string | undefined {
  if (!violations || violations.length === 0) return undefined;
  const lines: string[] = [`A11y violations under '${scenarioLabel}':`];
  for (const v of violations) {
    const help = v.helpUrl ? ` (${v.helpUrl})` : '';
    lines.push(
      `  • [${v.impact}] ${v.id}: ${v.description} — ${v.nodes} node${v.nodes === 1 ? '' : 's'}${help}`,
    );
    // Per-node evidence so the agent can locate the failing element without
    // re-running axe: `selector — axe failure summary` (HTML snippet is shown
    // too when present). Stays compact — this text is read by an agent.
    for (const n of v.nodeDetails ?? []) {
      const summary = n.failureSummary ? ` — ${n.failureSummary}` : '';
      lines.push(`      - ${n.target}${summary}`);
      if (n.html) lines.push(`        ${n.html}`);
    }
  }
  lines.push('  → Critical/serious axe-core violations. Fix or justify before scoring as pass.');
  return lines.join('\n');
}
