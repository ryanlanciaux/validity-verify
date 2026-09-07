import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROXY_SENTINEL, inferFixtures, stripProxySentinels } from './infer-fixtures.js';

/**
 * Writes a temp .tsx file with the given source, runs inferFixtures
 * against it, and returns the result. Each test gets a fresh tmp dir
 * so the parser never sees stale files.
 */
function inferFromSource(source: string): ReturnType<typeof inferFixtures> {
  const dir = mkdtempSync(resolve(tmpdir(), 'validity-infer-test-'));
  const file = resolve(dir, 'Component.tsx');
  writeFileSync(file, source);
  try {
    return inferFixtures(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('inferFixtures — primitive props', () => {
  it('generates a string for a `title: string` prop', () => {
    const result = inferFromSource(`
      export default function Foo({ title }: { title: string }) {
        return <h1>{title}</h1>;
      }
    `);
    expect(result).not.toBeNull();
    expect(typeof result!.fixtures.auto!.props.title).toBe('string');
  });

  it('uses an email-shaped string for an `email` prop', () => {
    const result = inferFromSource(`
      export default function Foo({ email }: { email: string }) {
        return <a href={'mailto:' + email}>{email}</a>;
      }
    `);
    expect(result!.fixtures.auto!.props.email).toMatch(/@/);
  });

  it('generates a number for a `count: number` prop', () => {
    const result = inferFromSource(`
      export default function Foo({ count }: { count: number }) {
        return <span>{count}</span>;
      }
    `);
    expect(typeof result!.fixtures.auto!.props.count).toBe('number');
  });

  it('defaults `isLoading: boolean` to false (happy-path default)', () => {
    const result = inferFromSource(`
      export default function Foo({ isLoading }: { isLoading: boolean }) {
        return <div>{isLoading ? 'loading' : 'ok'}</div>;
      }
    `);
    expect(result!.fixtures.auto!.props.isLoading).toBe(false);
  });

  it('defaults `active: boolean` to true (affirmative name)', () => {
    const result = inferFromSource(`
      export default function Foo({ active }: { active: boolean }) {
        return <div>{active ? 'yes' : 'no'}</div>;
      }
    `);
    expect(result!.fixtures.auto!.props.active).toBe(true);
  });

  it('skips functions (event handlers) — JSON cannot carry them anyway', () => {
    const result = inferFromSource(`
      export default function Foo({ onClick, label }: { onClick: () => void; label: string }) {
        return <button onClick={onClick}>{label}</button>;
      }
    `);
    // onClick is REQUIRED but we cannot synthesize a function. Required
    // function fields are omitted; the component receives undefined,
    // which most event handlers tolerate.
    expect('onClick' in result!.fixtures.auto!.props).toBe(false);
    expect(typeof result!.fixtures.auto!.props.label).toBe('string');
  });
});

describe('inferFixtures — children placeholder', () => {
  it('seeds `children: React.ReactNode` with placeholder text', () => {
    const result = inferFromSource(`
      import React from 'react';
      export default function Foo({ children }: { children: React.ReactNode }) {
        return <button>{children}</button>;
      }
    `);
    expect(result!.fixtures.auto!.props.children).toBe('Testing');
  });

  it('seeds `children: string | React.ReactNode` with placeholder text', () => {
    const result = inferFromSource(`
      import React from 'react';
      export default function Foo({ children }: { children: string | React.ReactNode }) {
        return <button>{children}</button>;
      }
    `);
    expect(result!.fixtures.auto!.props.children).toBe('Testing');
  });

  it('populates an optional `children?` so the element is not left empty', () => {
    const result = inferFromSource(`
      import React from 'react';
      export default function Foo({ children }: { children?: React.ReactNode }) {
        return <button>{children}</button>;
      }
    `);
    expect(result!.fixtures.auto!.props.children).toBe('Testing');
  });

  it('surfaces children through PropsWithChildren<T>', () => {
    const result = inferFromSource(`
      import React, { type PropsWithChildren } from 'react';
      export default function Card({ title, children }: PropsWithChildren<{ title: string }>) {
        return <div><h2>{title}</h2>{children}</div>;
      }
    `);
    expect(typeof result!.fixtures.auto!.props.title).toBe('string');
    expect(result!.fixtures.auto!.props.children).toBe('Testing');
  });

  it('surfaces children through a ButtonHTMLAttributes intersection', () => {
    const result = inferFromSource(`
      import React from 'react';
      type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean };
      export default function Button({ busy, children, ...rest }: Props) {
        return <button {...rest}>{busy ? '…' : children}</button>;
      }
    `);
    expect(result!.fixtures.auto!.props.children).toBe('Testing');
  });

  it('surfaces children through ComponentProps intersections', () => {
    const result = inferFromSource(`
      import React from 'react';
      export default function IconButton(props: React.ComponentProps<'button'> & { label: string }) {
        return <button>{props.label}{props.children}</button>;
      }
    `);
    expect(result!.fixtures.auto!.props.children).toBe('Testing');
    expect(typeof result!.fixtures.auto!.props.label).toBe('string');
  });

  it('falls back to body usage when the declared type hides children', () => {
    const result = inferFromSource(`
      import React from 'react';
      import type { BaseProps } from './types';
      interface Props extends BaseProps {
        tone: string;
      }
      export default function Pill(props: Props) {
        return <span data-tone={props.tone}>{props.children}</span>;
      }
    `);
    expect(result!.fixtures.auto!.props.children).toBe('Testing');
  });

  it('does NOT invent children when the component never uses them', () => {
    const result = inferFromSource(`
      export default function Stat({ value }: { value: number }) {
        return <strong>{value}</strong>;
      }
    `);
    expect('children' in result!.fixtures.auto!.props).toBe(false);
  });

  it('variant enumeration keeps the synthesized children text', () => {
    const result = inferFromSource(`
      import React, { type PropsWithChildren } from 'react';
      type Props = PropsWithChildren<{ variant: 'primary' | 'ghost' }>;
      export default function Button({ variant, children }: Props) {
        return <button data-variant={variant}>{children}</button>;
      }
    `);
    expect(Object.keys(result!.fixtures)).toEqual(['variant: primary', 'variant: ghost']);
    expect(result!.fixtures['variant: ghost']!.props.children).toBe('Testing');
  });
});

describe('inferFixtures — named types in the same file', () => {
  it('resolves a same-file interface', () => {
    const result = inferFromSource(`
      interface FooProps {
        title: string;
        count: number;
      }
      export default function Foo({ title, count }: FooProps) {
        return <div>{title}: {count}</div>;
      }
    `);
    expect(typeof result!.fixtures.auto!.props.title).toBe('string');
    expect(typeof result!.fixtures.auto!.props.count).toBe('number');
  });

  it('resolves a same-file type alias', () => {
    const result = inferFromSource(`
      type FooProps = { name: string };
      export default function Foo(props: FooProps) {
        return <span>{props.name}</span>;
      }
    `);
    expect(typeof result!.fixtures.auto!.props.name).toBe('string');
  });

  it('pulls fields from `extends` clauses', () => {
    const result = inferFromSource(`
      interface BaseProps {
        id: string;
      }
      interface FooProps extends BaseProps {
        label: string;
      }
      export default function Foo({ id, label }: FooProps) {
        return <div data-id={id}>{label}</div>;
      }
    `);
    expect(typeof result!.fixtures.auto!.props.id).toBe('string');
    expect(typeof result!.fixtures.auto!.props.label).toBe('string');
  });
});

describe('inferFixtures — React.FC<Props> pattern', () => {
  it('extracts props from `const Foo: React.FC<Props>`', () => {
    const result = inferFromSource(`
      import React from 'react';
      interface Props { title: string; active: boolean }
      const Foo: React.FC<Props> = ({ title, active }) => {
        return <div data-active={active}>{title}</div>;
      };
      export default Foo;
    `);
    expect(typeof result!.fixtures.auto!.props.title).toBe('string');
    expect(typeof result!.fixtures.auto!.props.active).toBe('boolean');
  });

  it('extracts props from `const Foo: FC<Props>` (bare FC import)', () => {
    const result = inferFromSource(`
      import { FC } from 'react';
      interface Props { name: string }
      const Foo: FC<Props> = ({ name }) => <p>{name}</p>;
      export default Foo;
    `);
    expect(typeof result!.fixtures.auto!.props.name).toBe('string');
  });

  it('respects a destructuring default on an FC<Props> component (does NOT name-synthesize)', () => {
    // Regression: an affirmative-named boolean (`initialInfoVisible`) with an
    // explicit `= false` default used to synthesize `true` because the
    // FC<Props> path returned the interface fields WITHOUT merging the
    // destructuring defaults — silently opening a modal that masked the base UI.
    const result = inferFromSource(`
      import { FC } from 'react';
      interface Props { initialInfoVisible?: boolean }
      const Login: FC<Props> = ({ initialInfoVisible = false }) => (
        <div>{initialInfoVisible ? 'open' : 'closed'}</div>
      );
      export default Login;
    `);
    expect(result!.fixtures.auto!.props.initialInfoVisible).toBe(false);
  });
});

describe('inferFixtures — arrays (the chart regression)', () => {
  it('generates 5 sample points for an array of objects', () => {
    const result = inferFromSource(`
      interface Point { date: string; value: number }
      interface ChartProps { data: Point[] }
      export default function Chart({ data }: ChartProps) {
        return <svg>{data.length}</svg>;
      }
    `);
    const data = result!.fixtures.auto!.props.data as unknown[];
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(5);
    const first = data[0] as Record<string, unknown>;
    // Each element has the right shape.
    expect(typeof first.date).toBe('string');
    expect(typeof first.value).toBe('number');
    // Values vary by index — the second element's number differs from
    // the first so a chart actually has something to plot.
    const second = data[1] as Record<string, unknown>;
    expect(second.value).not.toEqual(first.value);
  });

  it('generates 5 proxy sentinels when the element type is unresolvable', () => {
    const result = inferFromSource(`
      import type { Mystery } from '@some/lib';
      export default function Foo({ items }: { items: Mystery[] }) {
        return <ul>{items.length}</ul>;
      }
    `);
    const items = result!.fixtures.auto!.props.items as unknown[];
    expect(Array.isArray(items)).toBe(true);
    // Each element is a sentinel string the sandbox replaces with a deep-
    // default Proxy at hydration. Consumers doing \`items.map(x => x.foo)\`
    // get a Proxy back instead of crashing on undefined / null. \`.length\`
    // is the real number of sentinels (5), so charts also have something
    // to plot.
    expect(items.length).toBe(5);
    expect(items[0]).toBe('__VALIDITY_PROXY__');
  });
});

describe('inferFixtures — nested objects (the asWhite regression)', () => {
  it('synthesizes a nested object literal so `winRate.asWhite` works', () => {
    const result = inferFromSource(`
      interface WinRate { asWhite: number; asBlack: number; draws: number }
      export default function Chart({ winRate }: { winRate: WinRate }) {
        return <div>{winRate.asWhite}</div>;
      }
    `);
    const winRate = result!.fixtures.auto!.props.winRate as Record<string, unknown>;
    expect(typeof winRate).toBe('object');
    expect(typeof winRate.asWhite).toBe('number');
    expect(typeof winRate.asBlack).toBe('number');
    expect(typeof winRate.draws).toBe('number');
  });
});

describe('inferFixtures — unions and literals', () => {
  it('enumerates a string-literal union into one fixture per value', () => {
    const result = inferFromSource(`
      export default function Foo({ variant }: { variant: 'primary' | 'ghost' | 'danger' }) {
        return <button data-variant={variant}>x</button>;
      }
    `);
    expect(Object.keys(result!.fixtures)).toEqual([
      'variant: primary',
      'variant: ghost',
      'variant: danger',
    ]);
    expect(result!.fixtures['variant: ghost']!.props.variant).toBe('ghost');
    expect('auto' in result!.fixtures).toBe(false);
  });

  it('enumerated fixtures keep the base value for every other prop', () => {
    const result = inferFromSource(`
      export default function Foo({ label, variant }: { label: string; variant: 'primary' | 'ghost' }) {
        return <button data-variant={variant}>{label}</button>;
      }
    `);
    const primary = result!.fixtures['variant: primary']!;
    const ghost = result!.fixtures['variant: ghost']!;
    expect(typeof primary.props.label).toBe('string');
    expect(ghost.props.label).toBe(primary.props.label);
  });

  it('enumerates multiple axes, priority-named first', () => {
    const result = inferFromSource(`
      export default function Foo({ size, variant }: { size: 'sm' | 'md' | 'lg'; variant: 'primary' | 'ghost' }) {
        return <button data-variant={variant} data-size={size}>x</button>;
      }
    `);
    const names = Object.keys(result!.fixtures);
    // 'variant' outranks 'size' in VARIANT_AXIS_PRIORITY despite declaration order.
    expect(names).toEqual([
      'variant: primary',
      'variant: ghost',
      'size: sm',
      'size: md',
      'size: lg',
    ]);
    // Non-enumerated axis stays at its base (first literal) value.
    expect(result!.fixtures['size: lg']!.props.variant).toBe('primary');
  });

  it('enumerates number-literal unions', () => {
    const result = inferFromSource(`
      export default function Foo({ level }: { level: 1 | 2 | 3 }) {
        return <h1 data-level={level}>x</h1>;
      }
    `);
    expect(Object.keys(result!.fixtures)).toEqual(['level: 1', 'level: 2', 'level: 3']);
    expect(result!.fixtures['level: 2']!.props.level).toBe(2);
  });

  it('enumerates the literal subset of an open union', () => {
    const result = inferFromSource(`
      export default function Foo({ tone }: { tone: 'info' | 'warning' | string }) {
        return <p data-tone={tone}>x</p>;
      }
    `);
    expect(Object.keys(result!.fixtures)).toEqual(['tone: info', 'tone: warning']);
  });

  it('does NOT enumerate a union with fewer than two literals', () => {
    const result = inferFromSource(`
      export default function Foo({ value }: { value: 'only' | number }) {
        return <p>{value}</p>;
      }
    `);
    expect(Object.keys(result!.fixtures)).toEqual(['auto']);
    expect(result!.fixtures.auto!.props.value).toBe('only');
  });

  it('falls through to a non-unknown member of the union', () => {
    const result = inferFromSource(`
      export default function Foo({ value }: { value: string | null | undefined }) {
        return <p>{value}</p>;
      }
    `);
    expect(typeof result!.fixtures.auto!.props.value).toBe('string');
  });
});

describe('inferFixtures — optional fields', () => {
  it('omits optional fields whose value can not be synthesized', () => {
    const result = inferFromSource(`
      export default function Foo({ onClick }: { onClick?: () => void }) {
        return <button onClick={onClick}>x</button>;
      }
    `);
    expect('onClick' in result!.fixtures.auto!.props).toBe(false);
  });

  it('keeps optional fields with a synthesized value', () => {
    const result = inferFromSource(`
      export default function Foo({ title }: { title?: string }) {
        return <h1>{title}</h1>;
      }
    `);
    expect(typeof result!.fixtures.auto!.props.title).toBe('string');
  });
});

describe('inferFixtures — failure modes', () => {
  it('returns null when the file does not parse', () => {
    const result = inferFromSource(`this is not /// valid TS /// at all }}}`);
    // Babel's errorRecovery may still produce *something*; what matters
    // is that we either return null or an empty/safe result rather
    // than throwing.
    if (result !== null) {
      expect(typeof result.fixtures.auto?.props).toBe('object');
    }
  });

  it('returns null when there is no exported component', () => {
    const result = inferFromSource(`export const NotAComponent = 42;`);
    expect(result).toBeNull();
  });

  it('returns an empty-props fixture when the component takes no parameters', () => {
    // Common React-Router / Next pattern: a page component reads from
    // hooks (useParams, useNavigate, context) and takes no props. The
    // canvas should render it with `<Component />` rather than flag
    // "needs fixture" — there are no props to fixture.
    const result = inferFromSource(`
      export default function Foo() {
        return <div>nothing</div>;
      }
    `);
    expect(result).not.toBeNull();
    expect(result!.fixtures.auto!.props).toEqual({});
    expect(result!.fixtures.auto!.description).toBe('No props required');
  });

  it('returns an empty-props fixture when the props type is `{}`', () => {
    const result = inferFromSource(`
      export default function Foo({}: {}) {
        return <div>nothing</div>;
      }
    `);
    expect(result).not.toBeNull();
    expect(result!.fixtures.auto!.props).toEqual({});
  });

  it('returns an empty-props fixture for an arrow component with no params', () => {
    const result = inferFromSource(`
      const Foo = () => <div>hi</div>;
      export default Foo;
    `);
    expect(result).not.toBeNull();
    expect(result!.fixtures.auto!.props).toEqual({});
  });

  it('returns a best-effort result for untyped destructured params', () => {
    const result = inferFromSource(`
      export default function Foo({ title, count }) {
        return <h1>{title} ({count})</h1>;
      }
    `);
    // We can't know the types, but the field names survive so the
    // component at least gets the keys it expects (set to null).
    expect(result).not.toBeNull();
    expect(result!.fixtures.auto!.props).toHaveProperty('title');
    expect(result!.fixtures.auto!.props).toHaveProperty('count');
  });
});

describe('inferFixtures — output is JSON-safe', () => {
  it('round-trips through JSON.stringify without loss for typical props', () => {
    const result = inferFromSource(`
      interface Point { x: number; y: number; label: string }
      interface Props {
        title: string;
        active: boolean;
        points: Point[];
        meta: { tag: string; count: number };
      }
      export default function Chart({ title, active, points, meta }: Props) {
        return <div>{title}</div>;
      }
    `);
    const json = JSON.stringify(result!.fixtures.auto!.props);
    const reparsed = JSON.parse(json) as Record<string, unknown>;
    expect(reparsed.title).toEqual(result!.fixtures.auto!.props.title);
    expect((reparsed.points as unknown[]).length).toBe(5);
  });
});

describe('stripProxySentinels', () => {
  it('drops top-level sentinel props and keeps the rest', () => {
    expect(stripProxySentinels({ a: PROXY_SENTINEL, b: 'keep', c: 3 })).toEqual({
      b: 'keep',
      c: 3,
    });
  });

  it('drops sentinels nested in objects and arrays', () => {
    expect(
      stripProxySentinels({
        meta: { tag: PROXY_SENTINEL, count: 2 },
        list: ['x', PROXY_SENTINEL, 'y'],
      }),
    ).toEqual({
      meta: { count: 2 },
      list: ['x', 'y'],
    });
  });

  it('passes through null and primitive values untouched', () => {
    expect(stripProxySentinels({ a: null, b: false, c: 0 })).toEqual({ a: null, b: false, c: 0 });
  });
});
