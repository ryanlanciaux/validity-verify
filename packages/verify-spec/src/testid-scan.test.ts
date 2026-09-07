/**
 * `extractTestIds` (A3) — the lexical scan that surfaces a component's stable
 * testIDs to the spec-authoring agent. Load-bearing invariants: every static
 * literal form of `testID` / `data-testid` is picked up, a dynamic value is
 * NEVER treated as a stable matcher, and the result is deduped in first-seen
 * order so the hint reads as the agent would encounter them top-to-bottom.
 */
import { describe, expect, it } from 'vitest';
import { extractTestIds } from './testid-scan.js';

describe('extractTestIds', () => {
  it('matches all four static `testID` literal forms', () => {
    const source = `
      <Text testID="double" />
      <Text testID='single' />
      <Text testID={"brace-double"} />
      <Text testID={'brace-single'} />
    `;
    expect(extractTestIds(source)).toEqual(['double', 'single', 'brace-double', 'brace-single']);
  });

  it('matches the web `data-testid` analog in all four forms', () => {
    const source = `
      <div data-testid="d1" />
      <div data-testid='d2' />
      <div data-testid={"d3"} />
      <div data-testid={'d4'} />
    `;
    expect(extractTestIds(source)).toEqual(['d1', 'd2', 'd3', 'd4']);
  });

  it('ignores dynamic values (identifier, member, template, concatenation)', () => {
    const source = `
      <Text testID={id} />
      <Text testID={props.testID} />
      <Text testID={\`btn-\${id}\`} />
      <Text testID={"prefix-" + id} />
      <div data-testid={someVar} />
    `;
    expect(extractTestIds(source)).toEqual([]);
  });

  it('keeps the static literals when static and dynamic testIDs are mixed', () => {
    const source = `
      <Text testID="welcome-heading" />
      <Text testID={dynamicId} />
      <Pressable testID="next-screen-button" />
    `;
    expect(extractTestIds(source)).toEqual(['welcome-heading', 'next-screen-button']);
  });

  it('dedupes while preserving first-seen order', () => {
    const source = `
      <Text testID="b" />
      <Text testID="a" />
      <Text testID="b" />
      <div data-testid="a" />
      <Text testID="c" />
    `;
    expect(extractTestIds(source)).toEqual(['b', 'a', 'c']);
  });

  it('tolerates whitespace around `=` and inside the braces', () => {
    const source = `
      <Text testID = "spaced" />
      <Text testID={  "brace-spaced"  } />
    `;
    expect(extractTestIds(source)).toEqual(['spaced', 'brace-spaced']);
  });

  it('drops empty literals and does not false-match a longer prop name', () => {
    const source = `
      <Text testID="" />
      <Text myTestID="not-a-match" />
      <Text testIDValue="also-not" />
    `;
    expect(extractTestIds(source)).toEqual([]);
  });

  it('returns an empty array for a source with no testIDs', () => {
    expect(extractTestIds('<Text>hello</Text>')).toEqual([]);
    expect(extractTestIds('')).toEqual([]);
  });
});
