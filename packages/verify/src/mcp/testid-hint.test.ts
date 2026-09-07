/**
 * `testIdSourceHint` (A3) — the compact line surfaced next to the native a11y
 * snapshot (which has no testID channel) so the authoring agent sets
 * `selector.testId` instead of a brittle `text:` matcher. The line must name
 * the source's stable testIDs in order and point at the durable Maestro `id:`
 * export; a source with no static testID yields undefined so the caller omits
 * the line entirely.
 */
import { describe, expect, it } from 'vitest';
import { testIdSourceHint } from './server.js';

describe('testIdSourceHint', () => {
  it('names the source testIDs and points at the Maestro id: export', () => {
    const source = `
      <Text testID="welcome-heading" />
      <Pressable testID="next-screen-button" />
    `;
    expect(testIdSourceHint(source)).toBe(
      'testIDs in source (prefer selector.testId — exports as Maestro id:): welcome-heading, next-screen-button',
    );
  });

  it('dedupes and preserves first-seen order in the rendered line', () => {
    const source = `<div data-testid="a" /><div data-testid="b" /><div data-testid="a" />`;
    expect(testIdSourceHint(source)).toBe(
      'testIDs in source (prefer selector.testId — exports as Maestro id:): a, b',
    );
  });

  it('returns undefined when the source exposes no static testID', () => {
    expect(testIdSourceHint('<Text>hi</Text>')).toBeUndefined();
    expect(testIdSourceHint('<Text testID={dynamic} />')).toBeUndefined();
    expect(testIdSourceHint('')).toBeUndefined();
  });
});
