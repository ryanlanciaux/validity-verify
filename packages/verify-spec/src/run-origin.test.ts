import { describe, expect, it } from 'vitest';
import { detectRunOrigin } from './run-origin.js';

describe('detectRunOrigin', () => {
  it('is local for an empty env', () => {
    expect(detectRunOrigin({})).toBe('local');
  });

  it("is ci when GITHUB_ACTIONS === 'true'", () => {
    expect(detectRunOrigin({ GITHUB_ACTIONS: 'true' })).toBe('ci');
  });

  it('does not treat a non-"true" GITHUB_ACTIONS as ci on its own', () => {
    // The GitHub runner sets exactly 'true'; a stray 'false' must not read ci.
    expect(detectRunOrigin({ GITHUB_ACTIONS: 'false' })).toBe('local');
  });

  it("is ci for a truthy generic CI ('true' / '1', case-insensitive)", () => {
    expect(detectRunOrigin({ CI: 'true' })).toBe('ci');
    expect(detectRunOrigin({ CI: '1' })).toBe('ci');
    expect(detectRunOrigin({ CI: 'TRUE' })).toBe('ci');
    expect(detectRunOrigin({ CI: '  true  ' })).toBe('ci');
  });

  it('is local for an empty-string or non-truthy CI', () => {
    // Some shells export CI='' — that must not count as CI.
    expect(detectRunOrigin({ CI: '' })).toBe('local');
    expect(detectRunOrigin({ CI: 'false' })).toBe('local');
    expect(detectRunOrigin({ CI: '0' })).toBe('local');
  });

  it('is ci when any vendor marker is set non-empty', () => {
    for (const name of ['GITLAB_CI', 'CIRCLECI', 'BUILDKITE', 'JENKINS_URL', 'TF_BUILD']) {
      expect(detectRunOrigin({ [name]: 'yes' })).toBe('ci');
    }
  });

  it('is local when a vendor marker is present but empty', () => {
    expect(detectRunOrigin({ JENKINS_URL: '' })).toBe('local');
    expect(detectRunOrigin({ TF_BUILD: '   ' })).toBe('local');
  });
});
