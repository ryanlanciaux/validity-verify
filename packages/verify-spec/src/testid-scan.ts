/**
 * testID source scan (A3) — the authoring bridge that gets stable test IDs in
 * front of the spec-writing agent.
 *
 * A native selector exports to a durable Maestro `id:` matcher when it carries
 * a `testId`, but the agent authors selectors from the agent-device a11y
 * snapshot (free-text role/name nodes, NO testID channel) and screenshots, so
 * it never learns the `testID` the component source declares and falls back to
 * a brittle `text:` matcher. Surfacing the source's testIDs lets the agent set
 * `selector.testId` — the matcher that survives copy/i18n drift.
 *
 * Purely lexical (a single regex scan, no parse): it works on any source
 * string, mirrors the cloner's entry-file-only reach, and never throws.
 */

/**
 * Extract the static `testID` / `data-testid` string literals a source
 * declares, deduped in first-seen order.
 *
 * Matches the four static-literal forms of each attribute:
 *   testID="x"  testID='x'  testID={"x"}  testID={'x'}
 *   data-testid="x"  data-testid='x'  data-testid={"x"}  data-testid={'x'}
 * A dynamic value (`testID={expr}`, a template literal, a concatenation) is
 * deliberately ignored — it is not a stable matcher. Empty literals (`""`) are
 * dropped too.
 */
export function extractTestIds(source: string): string[] {
  const re =
    /\b(?:testID|data-testid)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*"([^"]*)"\s*\}|\{\s*'([^']*)'\s*\})/g;
  const seen = new Set<string>();
  const ids: string[] = [];
  for (let m = re.exec(source); m !== null; m = re.exec(source)) {
    const value = m[1] ?? m[2] ?? m[3] ?? m[4] ?? '';
    if (value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    ids.push(value);
  }
  return ids;
}
