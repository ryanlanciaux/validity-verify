import { describe, expect, it } from 'vitest';
import {
  buildDeepLink,
  buildDevClientLoadUrl,
  buildTargetUrl,
  encodeOverrides,
  encodeViewItems,
} from './deep-link.js';

describe('buildTargetUrl', () => {
  it('builds a custom-scheme URL for ios/android', () => {
    const url = buildTargetUrl(
      { component: 'src/Button.tsx', fixture: 'primary' },
      { target: 'ios', scheme: 'myapp' },
    );
    expect(url).toBe('myapp://validity?component=src%2FButton.tsx&fixture=primary');
  });

  it('builds an exp:// URL for Expo Go with default host', () => {
    const url = buildTargetUrl({ component: 'src/Button.tsx' }, { target: 'expo-go' });
    expect(url).toBe('exp://localhost:8081/--/validity?component=src%2FButton.tsx');
  });

  it('encodes prop overrides as base64 JSON', () => {
    const url = buildTargetUrl(
      { component: 'src/Button.tsx', overrides: { label: 'Cancel' } },
      { target: 'android', scheme: 'app' },
    );
    const enc = encodeOverrides({ label: 'Cancel' });
    expect(url).toContain(`overrides=${encodeURIComponent(enc)}`);
    expect(JSON.parse(Buffer.from(enc, 'base64').toString('utf-8'))).toEqual({ label: 'Cancel' });
  });

  it('throws when a scheme is missing for ios/android', () => {
    expect(() => buildTargetUrl({ component: 'x' }, { target: 'ios' })).toThrow(/scheme/i);
  });

  it('ships resolved view items inline as base64 JSON (ephemeral views, no rebuild)', () => {
    const items = [{ path: 'src/Button.tsx', label: 'Primary', props: { label: 'Go' } }];
    const url = buildTargetUrl(
      { view: 'Button Variants', viewItems: items },
      { target: 'ios', scheme: 'myapp' },
    );
    const enc = encodeViewItems(items);
    expect(url).toContain('view=Button+Variants');
    expect(url).toContain(`items=${encodeURIComponent(enc)}`);
    expect(JSON.parse(Buffer.from(enc, 'base64').toString('utf-8'))).toEqual(items);
  });

  it('omits items= for a plain component target (only views carry items)', () => {
    const url = buildTargetUrl(
      { component: 'src/Button.tsx', viewItems: [{ path: 'x', label: 'x', props: {} }] },
      { target: 'ios', scheme: 'myapp' },
    );
    expect(url).not.toContain('items=');
  });

  it('omits items= for a view with no resolved items', () => {
    const url = buildTargetUrl(
      { view: 'Empty', viewItems: [] },
      { target: 'ios', scheme: 'myapp' },
    );
    expect(url).not.toContain('items=');
  });

  it('ships the per-navigation token (the harness echoes it as validity-root:<token>)', () => {
    const url = buildTargetUrl(
      { component: 'src/Button.tsx', token: 'nav-abc-1' },
      { target: 'ios', scheme: 'myapp' },
    );
    expect(url).toContain('token=nav-abc-1');
  });

  it('omits token= when no token is provided (legacy shared-marker contract)', () => {
    const url = buildTargetUrl({ component: 'src/Button.tsx' }, { target: 'ios', scheme: 'myapp' });
    expect(url).not.toContain('token=');
  });
});

describe('buildDeepLink', () => {
  it('emits the xcrun command for ios', () => {
    const { command } = buildDeepLink(
      { component: 'src/Button.tsx' },
      { target: 'ios', scheme: 'myapp' },
    );
    expect(command).toMatch(/^xcrun simctl openurl booted "myapp:\/\/validity\?component=/);
  });

  it('emits the adb command for android with device-side quoting', () => {
    const { command, url } = buildDeepLink(
      { component: 'src/Button.tsx' },
      { target: 'android', scheme: 'myapp' },
    );
    // Host-level double quotes wrap the whole device command; the URL keeps
    // its own single quotes so they SURVIVE to the device `sh` — otherwise a
    // bare `&` in the query truncates the URL on-device (token lost).
    expect(command).toBe(`adb shell "am start -a android.intent.action.VIEW -d '${url}'"`);
    expect(url).toContain('component=');
  });

  it('emits a uri-scheme command for expo-go', () => {
    const { command, url } = buildDeepLink({ component: 'src/Button.tsx' }, { target: 'expo-go' });
    expect(command).toBe(`npx uri-scheme open "${url}"`);
  });
});

describe('buildDevClientLoadUrl', () => {
  it('builds the expo-development-client control link with a url-encoded metro url', () => {
    expect(buildDevClientLoadUrl('myapp', 'http://localhost:8082')).toBe(
      'myapp://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8082',
    );
  });

  it('defaults the metro url when omitted', () => {
    expect(buildDevClientLoadUrl('myapp')).toBe(
      'myapp://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081',
    );
  });

  it('throws when the scheme is missing', () => {
    expect(() => buildDevClientLoadUrl('', 'http://localhost:8082')).toThrow(/scheme/i);
  });
});
