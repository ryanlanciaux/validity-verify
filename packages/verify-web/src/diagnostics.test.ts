import { describe, expect, it } from 'vitest';
import { formatDiagnosticsBlock, hasDiagnostics, type Diagnostics } from './diagnostics.js';

function emptyDiagnostics(): Diagnostics {
  return { consoleErrors: [], pageErrors: [], networkErrors: [] };
}

describe('hasDiagnostics', () => {
  it('false when every array is empty', () => {
    expect(hasDiagnostics(emptyDiagnostics())).toBe(false);
  });

  it('true when any array has an entry', () => {
    expect(hasDiagnostics({ ...emptyDiagnostics(), consoleErrors: [{ text: 'boom' }] })).toBe(true);
    expect(hasDiagnostics({ ...emptyDiagnostics(), pageErrors: [{ message: 'oops' }] })).toBe(true);
    expect(
      hasDiagnostics({
        ...emptyDiagnostics(),
        networkErrors: [{ method: 'GET', url: 'http://x/y', status: 500 }],
      }),
    ).toBe(true);
  });
});

describe('formatDiagnosticsBlock', () => {
  it('returns undefined for an empty snapshot — caller skips the section', () => {
    expect(formatDiagnosticsBlock(emptyDiagnostics(), 'base')).toBeUndefined();
  });

  it('includes the scenario label in the heading', () => {
    const out = formatDiagnosticsBlock(
      { ...emptyDiagnostics(), pageErrors: [{ message: 'kaboom' }] },
      'logged-in',
    );
    expect(out).toContain("Diagnostics under 'logged-in'");
  });

  it('lists page errors with a count header and bullets', () => {
    const out = formatDiagnosticsBlock(
      {
        ...emptyDiagnostics(),
        pageErrors: [{ message: 'TypeError: Cannot read x' }, { message: 'second' }],
      },
      'base',
    );
    expect(out).toContain('Uncaught errors (2)');
    expect(out).toContain('TypeError: Cannot read x');
    expect(out).toContain('second');
  });

  it('lists console errors with source location when available', () => {
    const out = formatDiagnosticsBlock(
      {
        ...emptyDiagnostics(),
        consoleErrors: [
          { text: 'boom', url: 'http://localhost:5180/src/Foo.tsx', lineNumber: 42 },
          { text: 'just text, no url' },
        ],
      },
      'base',
    );
    expect(out).toContain('Console errors (2)');
    expect(out).toContain('boom');
    expect(out).toContain('http://localhost:5180/src/Foo.tsx:42');
    expect(out).toContain('just text, no url');
  });

  it('lists network errors with method, url, and status', () => {
    const out = formatDiagnosticsBlock(
      {
        ...emptyDiagnostics(),
        networkErrors: [
          { method: 'POST', url: 'http://api/users', status: 500, statusText: 'Server Error' },
          { method: 'GET', url: 'http://api/x', status: 404 },
        ],
      },
      'base',
    );
    expect(out).toContain('Failed network responses (2)');
    expect(out).toContain('POST http://api/users → 500 Server Error');
    expect(out).toContain('GET http://api/x → 404');
  });

  it('emits the "do not pass without investigating" hint', () => {
    const out = formatDiagnosticsBlock(
      { ...emptyDiagnostics(), pageErrors: [{ message: 'x' }] },
      'base',
    );
    expect(out).toContain('investigate before scoring as pass');
  });
});
