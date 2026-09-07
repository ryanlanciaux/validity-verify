/**
 * The Next.js RSC split as the server actually computes it (E2.4): a real
 * on-disk fixture holding BOTH kinds of file, read through the same
 * framework-gated path `validity__catalog` and `validity__verify` use.
 *
 * `rsc.test.ts` in core covers the classification rules on fixture strings.
 * What can only be tested here is the wiring: that the gate really is the
 * detected framework, that absolute render paths and relative catalog paths
 * both normalize to the same project-relative key, and that a file the sandbox
 * cannot read never gets reported as verifiable.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RSC_EXCLUSION_REASON, formatRscBlock } from '@validity.ai/verify-spec';
import { classifyNextEntries } from './server.js';

const FILES: Record<string, string> = {
  'app/page.tsx': 'export default async function Page() {\n  return <main />;\n}\n',
  'app/Counter.tsx': "'use client';\nexport function Counter() {\n  return <button />;\n}\n",
  'components/Button.tsx': 'export function Button() {\n  return <button />;\n}\n',
  'pages/legacy.tsx': 'export default function Legacy() {\n  return <div />;\n}\n',
};

const ALL = Object.keys(FILES);

function scaffold(projectRoot: string, deps: Record<string, string>): void {
  writeFileSync(
    resolve(projectRoot, 'package.json'),
    JSON.stringify({ name: 'fixture', dependencies: deps }, null, 2),
  );
  for (const [rel, source] of Object.entries(FILES)) {
    const abs = resolve(projectRoot, rel);
    mkdirSync(resolve(abs, '..'), { recursive: true });
    writeFileSync(abs, source);
  }
}

describe('classifyNextEntries — a Next fixture with server AND client components', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-rsc-'));
    scaffold(projectRoot, { next: '15.0.0', react: '19.0.0' });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('names app/page.tsx as the one server component and the other three as verifiable', () => {
    const rsc = classifyNextEntries(projectRoot, ALL)!;
    expect(rsc.excluded).toEqual([{ path: 'app/page.tsx', reason: RSC_EXCLUSION_REASON }]);
    expect(rsc.verifiable).toEqual([
      'app/Counter.tsx',
      'components/Button.tsx',
      'pages/legacy.tsx',
    ]);
  });

  it('reaches the same split from the ABSOLUTE paths a verify run carries', () => {
    const absolute = ALL.map((p) => resolve(projectRoot, p));
    expect(classifyNextEntries(projectRoot, absolute)).toEqual(
      classifyNextEntries(projectRoot, ALL),
    );
  });

  it('produces a catalog message that states both halves and the way out', () => {
    const block = formatRscBlock(classifyNextEntries(projectRoot, ALL)!)!;
    expect(block).toContain(`Excluded (${RSC_EXCLUSION_REASON}): app/page.tsx`);
    expect(block).toContain('Verifiable: app/Counter.tsx, components/Button.tsx, pages/legacy.tsx');
    expect(block).toContain('validity__verify({ url })');
  });

  it('treats an unreadable App Router file as a server component, never as verifiable', () => {
    const rsc = classifyNextEntries(projectRoot, [...ALL, 'app/deleted.tsx'])!;
    expect(rsc.excluded.map((e) => e.path)).toEqual(['app/page.tsx', 'app/deleted.tsx']);
    expect(rsc.verifiable).not.toContain('app/deleted.tsx');
  });
});

describe('classifyNextEntries — the framework gate', () => {
  let projectRoot: string;

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('says nothing on a Vite project — there is no RSC boundary to report', () => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-rsc-vite-'));
    scaffold(projectRoot, { vite: '6.0.0', react: '19.0.0' });
    expect(classifyNextEntries(projectRoot, ALL)).toBeUndefined();
  });

  it('emits no block for a Next project that is entirely client-verifiable', () => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-rsc-clean-'));
    scaffold(projectRoot, { next: '15.0.0' });
    const rsc = classifyNextEntries(projectRoot, ['components/Button.tsx', 'app/Counter.tsx'])!;
    expect(rsc.excluded).toEqual([]);
    expect(formatRscBlock(rsc)).toBeUndefined();
  });
});
