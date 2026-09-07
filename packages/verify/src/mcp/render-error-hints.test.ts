import { describe, expect, it } from 'vitest';
import { annotateRenderError } from './server.js';

describe('annotateRenderError', () => {
  it('appends a wrapper.user.tsx hint for useNavigate errors', () => {
    const raw =
      'Validity component error: Error: useNavigate() may be used only in the context of a <Router> component.';
    const out = annotateRenderError(raw);
    expect(out).toContain(raw);
    expect(out).toContain('MemoryRouter');
    expect(out).toContain('.validity/wrapper.user.tsx');
    expect(out).toContain('do NOT switch to URL mode');
  });

  it('appends a hint for useLocation errors', () => {
    const out = annotateRenderError(
      'useLocation() may be used only in the context of a <Router> component.',
    );
    expect(out).toContain('MemoryRouter');
  });

  it('appends a hint for missing Redux provider', () => {
    const out = annotateRenderError(
      'Error: could not find react-redux context value; please ensure the component is wrapped in a <Provider>',
    );
    expect(out).toContain('Provider store');
    expect(out).toContain('react-redux');
  });

  it('appends a hint for missing QueryClient', () => {
    const out = annotateRenderError('No QueryClient set, use QueryClientProvider to set one');
    expect(out).toContain('QueryClientProvider');
    expect(out).toContain('@tanstack/react-query');
  });

  it('extracts a project-specific provider name from "must be used within"', () => {
    const out = annotateRenderError(
      'Validity component error: Error: useTrainingGeneration must be used within TrainingGenerationProvider',
    );
    expect(out).toContain('TrainingGenerationProvider');
    expect(out).toContain('.validity/wrapper.user.tsx');
    expect(out).toContain('STAY IN ISOLATION MODE');
    expect(out).toContain('grep -r');
    expect(out).toContain('export default function UserWrapper');
  });

  it('extracts a provider name across phrasing variants', () => {
    const variants = [
      'useFoo must be used within FooProvider',
      'useFoo must be used within a FooProvider',
      'useFoo must be used within an AccountProvider',
      'useFoo must be used inside FooProvider',
      'useFoo must be used within the FooProvider',
      'useFoo must be used within <FooProvider>',
    ];
    for (const v of variants) {
      const out = annotateRenderError(v);
      expect(out, `variant: ${v}`).toMatch(/<\w*Provider>/);
      expect(out, `variant: ${v}`).toContain('wrapper.user.tsx');
    }
  });

  it('falls through to the undefined-property hint when no provider name is in the message', () => {
    const out = annotateRenderError(
      'TypeError: Cannot read properties of undefined (reading "value") at useFooBar (file.tsx:1:2)',
    );
    expect(out).toContain('missing React Context provider');
    expect(out).toContain('wrapper.user.tsx');
  });

  it('returns the message unchanged when no pattern matches', () => {
    const raw = 'SyntaxError: unexpected token at line 5';
    expect(annotateRenderError(raw)).toBe(raw);
  });
});
