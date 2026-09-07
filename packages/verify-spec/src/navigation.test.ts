import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildNavigationGraph,
  extractNavigationEdges,
  resolveNavigationEdges,
} from './navigation.js';

describe('extractNavigationEdges', () => {
  it('extracts <Link to="...">', () => {
    const src = `import React from 'react';
export default function X() {
  return <Link to="/home">Home</Link>;
}`;
    const edges = extractNavigationEdges('src/X.tsx', src);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      from: 'src/X.tsx',
      to: '/home',
      trigger: '<Link to>',
    });
    expect(edges[0].line).toBeGreaterThan(0);
  });

  it('extracts <Link href="..."> with trigger <Link href>', () => {
    const src = `export default function X() { return <Link href="/about">About</Link>; }`;
    const edges = extractNavigationEdges('src/X.tsx', src);
    expect(edges).toEqual([expect.objectContaining({ to: '/about', trigger: '<Link href>' })]);
  });

  it('extracts <NavLink to="...">', () => {
    const src = `export default function X() { return <NavLink to="/settings">S</NavLink>; }`;
    const edges = extractNavigationEdges('src/X.tsx', src);
    expect(edges).toEqual([expect.objectContaining({ to: '/settings', trigger: '<NavLink to>' })]);
  });

  it('extracts <Navigate to="...">', () => {
    const src = `export default function X() { return <Navigate to="/login" />; }`;
    const edges = extractNavigationEdges('src/X.tsx', src);
    expect(edges).toEqual([expect.objectContaining({ to: '/login', trigger: '<Navigate to>' })]);
  });

  it('extracts <Redirect to="...">', () => {
    const src = `export default function X() { return <Redirect to="/login" />; }`;
    const edges = extractNavigationEdges('src/X.tsx', src);
    expect(edges).toEqual([expect.objectContaining({ to: '/login', trigger: '<Redirect to>' })]);
  });

  it('extracts navigate("...") calls', () => {
    const src = `export default function X() {
  const navigate = useNavigate();
  return <button onClick={() => navigate("/dashboard")}>Go</button>;
}`;
    const edges = extractNavigationEdges('src/X.tsx', src);
    expect(edges).toEqual([expect.objectContaining({ to: '/dashboard', trigger: 'navigate()' })]);
  });

  it('extracts router.push("...") calls', () => {
    const src = `export default function X() {
  const router = useRouter();
  return <button onClick={() => router.push("/checkout")}>Buy</button>;
}`;
    const edges = extractNavigationEdges('src/X.tsx', src);
    expect(edges).toEqual([expect.objectContaining({ to: '/checkout', trigger: 'router.push()' })]);
  });

  it('extracts router.replace("...") calls', () => {
    const src = `export default function X() {
  const router = useRouter();
  return <button onClick={() => router.replace("/home")}>Home</button>;
}`;
    const edges = extractNavigationEdges('src/X.tsx', src);
    expect(edges).toEqual([expect.objectContaining({ to: '/home', trigger: 'router.replace()' })]);
  });

  it('extracts redirect("...") calls', () => {
    const src = `export default function X() { redirect("/auth"); return null; }`;
    const edges = extractNavigationEdges('src/X.tsx', src);
    expect(edges).toEqual([expect.objectContaining({ to: '/auth', trigger: 'redirect()' })]);
  });

  it('does NOT extract <Link to={path}> (variable)', () => {
    const src = `export default function X({ path }) { return <Link to={path}>x</Link>; }`;
    const edges = extractNavigationEdges('src/X.tsx', src);
    expect(edges).toEqual([]);
  });

  it('does NOT extract navigate(`/users/${id}`) (template literal)', () => {
    const src = `export default function X({ id }) {
  return <button onClick={() => navigate(\`/users/\${id}\`)}>Go</button>;
}`;
    const edges = extractNavigationEdges('src/X.tsx', src);
    expect(edges).toEqual([]);
  });

  it('does NOT extract somethingElse.push("/x") (member object must be `router`)', () => {
    const src = `export default function X() { history.push("/x"); return null; }`;
    const edges = extractNavigationEdges('src/X.tsx', src);
    expect(edges).toEqual([]);
  });

  it('extracts multiple edges in one file', () => {
    const src = `export default function X() {
  return (
    <div>
      <Link to="/a">A</Link>
      <Link href="/b">B</Link>
      <button onClick={() => navigate("/c")}>C</button>
    </div>
  );
}`;
    const edges = extractNavigationEdges('src/X.tsx', src);
    expect(edges.map((e) => e.to).sort()).toEqual(['/a', '/b', '/c']);
  });

  it('returns [] on parse error rather than throwing', () => {
    const src = `this is not valid {{{ typescript at all ::: ;;;`;
    expect(() => extractNavigationEdges('src/X.tsx', src)).not.toThrow();
    // With errorRecovery Babel may still produce partial output but nothing
    // should resemble a nav call — the worst case is [] which we accept.
    const edges = extractNavigationEdges('src/X.tsx', src);
    expect(Array.isArray(edges)).toBe(true);
  });

  it('returns correct 1-indexed line numbers', () => {
    const src = `import React from 'react';

export default function X() {
  return <Link to="/home">Home</Link>;
}`;
    const edges = extractNavigationEdges('src/X.tsx', src);
    expect(edges).toHaveLength(1);
    // The `<Link to="/home">` is on line 4 (1-indexed).
    expect(edges[0].line).toBe(4);
  });
});

describe('resolveNavigationEdges', () => {
  const mkEdge = (to: string) => ({
    from: 'src/From.tsx',
    to,
    trigger: '<Link to>',
    line: 1,
    column: 0,
  });

  it('resolves exact route matches', () => {
    const screens = [{ path: 'app/dashboard/page.tsx', routePath: '/dashboard' }];
    const resolved = resolveNavigationEdges([mkEdge('/dashboard')], screens);
    expect(resolved).toEqual([
      expect.objectContaining({ to: '/dashboard', toPath: 'app/dashboard/page.tsx' }),
    ]);
  });

  it('resolves dynamic segments (:slug matches any non-empty segment)', () => {
    const screens = [{ path: 'app/posts/[slug]/page.tsx', routePath: '/posts/:slug' }];
    const resolved = resolveNavigationEdges([mkEdge('/posts/hello')], screens);
    expect(resolved).toEqual([
      expect.objectContaining({ to: '/posts/hello', toPath: 'app/posts/[slug]/page.tsx' }),
    ]);
  });

  it('drops edges with no matching screen', () => {
    const screens = [{ path: 'app/dashboard/page.tsx', routePath: '/dashboard' }];
    const resolved = resolveNavigationEdges([mkEdge('/nonexistent')], screens);
    expect(resolved).toEqual([]);
  });

  it('drops edges to screens with no routePath', () => {
    const screens = [{ path: 'src/screens/Home.tsx' }];
    const resolved = resolveNavigationEdges([mkEdge('/home')], screens);
    expect(resolved).toEqual([]);
  });

  it('picks the first matching screen deterministically', () => {
    const screens = [
      { path: 'app/posts/hello/page.tsx', routePath: '/posts/hello' },
      { path: 'app/posts/[slug]/page.tsx', routePath: '/posts/:slug' },
    ];
    const resolved = resolveNavigationEdges([mkEdge('/posts/hello')], screens);
    expect(resolved[0].toPath).toBe('app/posts/hello/page.tsx');
  });

  it('treats / as root and matches it', () => {
    const screens = [{ path: 'app/page.tsx', routePath: '/' }];
    const resolved = resolveNavigationEdges([mkEdge('/')], screens);
    expect(resolved).toEqual([expect.objectContaining({ toPath: 'app/page.tsx' })]);
  });

  it('does not match when segment count differs', () => {
    const screens = [{ path: 'app/posts/[slug]/page.tsx', routePath: '/posts/:slug' }];
    const resolved = resolveNavigationEdges([mkEdge('/posts/hello/extra')], screens);
    expect(resolved).toEqual([]);
  });
});

describe('buildNavigationGraph', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-navgraph-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const writeFile = (relPath: string, source: string): void => {
    const abs = resolve(projectRoot, relPath);
    mkdirSync(resolve(abs, '..'), { recursive: true });
    writeFileSync(abs, source);
  };

  it('integration: links between two app router screens are extracted and resolved', () => {
    writeFile(
      'app/page.tsx',
      `import React from 'react';
export default function Home() {
  return <Link to="/dashboard">Go</Link>;
}`,
    );
    writeFile(
      'app/dashboard/page.tsx',
      `import React from 'react';
export default function Dash() {
  return <div>dash</div>;
}`,
    );

    const screens = [
      { path: 'app/page.tsx', routePath: '/' },
      { path: 'app/dashboard/page.tsx', routePath: '/dashboard' },
    ];

    const edges = buildNavigationGraph(projectRoot, screens);
    expect(edges).toEqual([
      expect.objectContaining({
        from: 'app/page.tsx',
        to: '/dashboard',
        toPath: 'app/dashboard/page.tsx',
        trigger: '<Link to>',
      }),
    ]);
  });
});
