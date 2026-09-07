import { describe, expect, it } from 'vitest';
import type { A11yViolation } from '@validity.ai/verify-spec';
import { formatA11yBlock, toNodeDetails } from './a11y.js';

describe('toNodeDetails', () => {
  it('bounds the slice to 5 nodes even when axe reports more', () => {
    const nodes = Array.from({ length: 12 }, (_, i) => ({
      target: [`button:nth-child(${i + 1})`],
      html: `<button>btn ${i + 1}</button>`,
      failureSummary: 'Fix any of the following',
    }));
    expect(toNodeDetails(nodes)).toHaveLength(5);
  });

  it('returns undefined when axe produced no nodes (back-compat, stays absent)', () => {
    expect(toNodeDetails([])).toBeUndefined();
  });

  it('flattens a simple string target into one selector', () => {
    const details = toNodeDetails([{ target: ['#save'], html: '<button id="save"' }]);
    expect(details?.[0]?.target).toBe('#save');
  });

  it('flattens shadow-DOM crossing targets (array entries) with spaces', () => {
    // axe path: iframe -> shadow root -> button (each crossing is an array entry
    // that is itself a string[] of in-tree selectors).
    const details = toNodeDetails([{ target: ['iframe', ['#shadow-root', 'button.primary']] }]);
    const t = details?.[0]?.target;
    expect(t).toContain('iframe');
    expect(t).toContain('button.primary');
    expect(t).toContain('#shadow-root');
    expect(t).toBe('iframe #shadow-root button.primary');
  });

  it('truncates the html snippet to 160 chars and appends …', () => {
    const long = '<button>' + 'x'.repeat(400) + '</button>';
    const details = toNodeDetails([{ target: ['b'], html: long }]);
    const html = details?.[0]?.html;
    expect(html).toBeDefined();
    expect(html!.length).toBeLessThanOrEqual(161);
    expect(html!.endsWith('…')).toBe(true);
    expect(html!.slice(0, 160)).toBe(long.slice(0, 160));
  });

  it('truncates the failureSummary to 200 chars and appends …', () => {
    const summary =
      'Element does not have inner text that is visible to screen readers. ' + 'y'.repeat(400);
    const details = toNodeDetails([{ target: ['b'], failureSummary: summary }]);
    const s = details?.[0]?.failureSummary;
    expect(s!.length).toBeLessThanOrEqual(201);
    expect(s!.endsWith('…')).toBe(true);
    expect(s!.slice(0, 200)).toBe(summary.slice(0, 200));
  });

  it('truncates a deep/shadow-DOM target selector to 200 chars and appends …', () => {
    // A pathological selector chain (deep DOM or many shadow crossings) must not
    // bloat run-meta / the tool response — the selector gets the same budget
    // treatment as html and failureSummary.
    const deep = Array.from({ length: 60 }, (_, i) => `div.level-${i}`);
    const details = toNodeDetails([{ target: deep }]);
    const t = details?.[0]?.target;
    expect(t).toBeDefined();
    expect(t!.length).toBeLessThanOrEqual(201);
    expect(t!.endsWith('…')).toBe(true);
    expect(t!.slice(0, 200)).toBe(deep.join(' ').slice(0, 200));
  });

  it('survives a malformed axe node (missing target) without dropping siblings', () => {
    // axe is external; a node with no `target` must not throw and let runAxe's
    // catch discard every violation for the render. The bad node degrades to an
    // empty selector; well-formed siblings are unaffected.
    const nodes = [
      { html: '<button>oops</button>' }, // malformed: no target field
      { target: ['#ok'], html: '<button id="ok">' },
    ] as unknown as Parameters<typeof toNodeDetails>[0];
    const details = toNodeDetails(nodes);
    expect(details).toHaveLength(2);
    expect(details?.[0]?.target).toBe('');
    expect(details?.[1]?.target).toBe('#ok');
  });

  it('omits html/failureSummary when axe did not supply them', () => {
    const details = toNodeDetails([{ target: ['button'] }]);
    expect(details?.[0]).toEqual({ target: 'button' });
    expect(details?.[0]?.html).toBeUndefined();
    expect(details?.[0]?.failureSummary).toBeUndefined();
  });
});

describe('formatA11yBlock', () => {
  it('returns undefined when there are no violations', () => {
    expect(formatA11yBlock(undefined, 'base')).toBeUndefined();
    expect(formatA11yBlock([], 'base')).toBeUndefined();
  });

  it('formats each violation with impact, id, description, and node count', () => {
    const text = formatA11yBlock(
      [
        {
          id: 'label',
          impact: 'critical',
          description: 'Form elements must have labels',
          helpUrl: 'https://example.test/label',
          nodes: 2,
        },
        {
          id: 'color-contrast',
          impact: 'serious',
          description: 'Element has insufficient contrast',
          nodes: 1,
        },
      ],
      'logged-in',
    );
    expect(text).toBeDefined();
    expect(text).toContain("A11y violations under 'logged-in'");
    expect(text).toContain('[critical]');
    expect(text).toContain('label');
    expect(text).toContain('Form elements must have labels');
    expect(text).toContain('2 nodes');
    expect(text).toContain('[serious]');
    expect(text).toContain('color-contrast');
    expect(text).toContain('1 node');
    expect(text).toContain('https://example.test/label');
  });

  it('renders per-node selector and failure summary as indented sub-lines', () => {
    const text = formatA11yBlock(
      [
        {
          id: 'button-name',
          impact: 'critical',
          description: 'Buttons must have discernible text',
          nodes: 3,
          nodeDetails: [
            {
              target: 'button.border-white\\/10.bg-white',
              html: '<button class="border-white/10 bg-white">',
              failureSummary: 'Element does not have inner text that is visible to screen readers',
            },
          ],
        },
      ],
      'base',
    );
    expect(text).toBeDefined();
    expect(text).toContain('      - button.border-white\\/10.bg-white');
    expect(text).toContain('Element does not have inner text that is visible to screen readers');
    // The HTML snippet renders too, below the selector line.
    expect(text).toContain('<button class="border-white/10 bg-white">');
  });

  it('appends the actionable hint footer', () => {
    const text = formatA11yBlock(
      [{ id: 'x', impact: 'serious', description: 'd', nodes: 1 }] satisfies A11yViolation[],
      'base',
    );
    expect(text).toContain('Critical/serious axe-core violations');
  });
});
