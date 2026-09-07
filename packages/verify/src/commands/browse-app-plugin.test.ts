/**
 * The OPTIONAL app-plugin advisory printed under `validity browse --native`'s
 * readiness checklist. Pinned at the function boundary (same approach as
 * browse-native-status.test.ts) because the wording IS the product here: the
 * block has to read as optional guidance about the USER's app, never as another
 * gate on the companion playground, and it must never claim something it did
 * not observe.
 */
import { describe, expect, it } from 'vitest';
import { formatAppPluginAdvisory } from './browse.js';
import { defaultCompanionScheme, type NativePluginInfo } from '@validity.ai/verify-native';

const COMPANION = defaultCompanionScheme('ai.validity.playground');

function detection(over: Partial<NativePluginInfo> = {}): NativePluginInfo {
  return {
    installed: true,
    listed: true,
    scheme: 'my-app',
    pluginVersion: '0.0.1',
    registeredSchemes: ['my-app'],
    ...over,
  };
}

describe('formatAppPluginAdvisory', () => {
  it('prints nothing when the Expo config could not be resolved', () => {
    // "We could not look" must never render as "we looked and it is fine" —
    // nor as "it is missing". Silence is the only honest output.
    expect(formatAppPluginAdvisory('unknown', COMPANION)).toBe('');
  });

  it('confirms an installed plugin with its version and the app’s scheme', () => {
    const text = formatAppPluginAdvisory(detection(), COMPANION);
    expect(text).toContain('@validity.ai/verify-plugin-expo');
    expect(text).toContain('v0.0.1');
    expect(text).toContain('"my-app"');
  });

  it('offers the install command when the plugin is absent', () => {
    const text = formatAppPluginAdvisory(
      detection({ installed: false, listed: false, scheme: undefined, pluginVersion: undefined }),
      COMPANION,
    );
    expect(text).toContain('not installed');
    expect(text).toContain('npx expo install @validity.ai/verify-plugin-expo');
  });

  it('distinguishes listed-but-not-applied from simply absent', () => {
    // A plugin named in expo.plugins that produced no stamp did NOT run —
    // usually because the package is not installed. Reporting that as
    // "not installed" would hide the actionable half of the story.
    const text = formatAppPluginAdvisory(
      detection({ installed: false, listed: true, scheme: undefined, pluginVersion: undefined }),
      COMPANION,
    );
    expect(text).toContain('listed in expo.plugins but it did not run');
  });

  it('notes an app with no URL scheme at all', () => {
    const text = formatAppPluginAdvisory(
      detection({ installed: false, listed: false, scheme: undefined, registeredSchemes: [] }),
      COMPANION,
    );
    expect(text).toContain('cannot be deep-linked directly');
  });

  it('does not nag about the scheme once the plugin established one', () => {
    const text = formatAppPluginAdvisory(detection(), COMPANION);
    expect(text).not.toContain('cannot be deep-linked');
  });

  it('raises the companion/user scheme collision', () => {
    const text = formatAppPluginAdvisory(
      detection({ scheme: COMPANION, registeredSchemes: [COMPANION] }),
      COMPANION,
    );
    expect(text).toContain('nondeterministically');
    expect(text).toContain('native.scheme');
  });

  it('stays quiet about parity when the two apps hold different schemes', () => {
    expect(formatAppPluginAdvisory(detection(), COMPANION)).not.toContain('nondeterministically');
  });

  it('never emits checklist-blocker wording', () => {
    // The readiness checklist owns "Next:" and its ✓/→ vocabulary. This block
    // is advisory and must not be mistakable for a gate.
    for (const d of [detection(), detection({ installed: false, listed: false })]) {
      const text = formatAppPluginAdvisory(d, COMPANION);
      expect(text).not.toContain('Next:');
      expect(text).toContain('(optional)');
    }
  });
});
