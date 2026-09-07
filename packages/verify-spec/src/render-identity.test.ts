/**
 * Render identity — byte-identity primitives shared by lean verify and the
 * watch tick. The load-bearing invariants: identity is only ever `true` on
 * PROOF (matching bytes, or a matching recorded hash after pruning); every
 * failure mode degrades to 'unknown'/false — the stale/keep direction, never
 * a false identity.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  buildPrevRenderIndex,
  buildRenderIdentity,
  renderUnchangedForFold,
  screenshotsIdentical,
  stampScreenshotHashes,
} from './render-identity.js';
import type { RunMeta } from './run.js';
import type { ComponentRender } from './types.js';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'validity-render-identity-'));
  roots.push(dir);
  return dir;
}

function png(dir: string, name: string, bytes: string): string {
  mkdirSync(dir, { recursive: true });
  const p = resolve(dir, name);
  writeFileSync(p, bytes);
  return p;
}

function sha(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function render(over: Partial<ComponentRender> & Pick<ComponentRender, 'screenshotPath'>) {
  return { id: 'Comp', filePath: 'src/Comp.tsx', ...over };
}

function prevMeta(components: Partial<ComponentRender>[]): RunMeta {
  return {
    runId: 'run-prev',
    createdAt: '2026-07-01T00:00:00.000Z',
    mode: 'isolation',
    specId: 'spec-a',
    specHash: 'h1',
    components: components as ComponentRender[],
  } as RunMeta;
}

describe('stampScreenshotHashes', () => {
  it('stamps sha256 onto evidence renders and skips errored/skipped/unconfirmed ones', () => {
    const dir = tmp();
    const good = render({ screenshotPath: png(dir, 'good.png', 'pixels') });
    const errored = render({ screenshotPath: png(dir, 'err.png', 'x'), renderError: 'boom' });
    const skipped = render({ screenshotPath: png(dir, 'skip.png', 'x'), screenshotSkipped: true });
    const unconfirmed = render({
      screenshotPath: png(dir, 'unc.png', 'x'),
      renderConfirmation: 'unconfirmed',
    });
    stampScreenshotHashes([good, errored, skipped, unconfirmed]);
    expect(good.screenshotSha256).toBe(sha('pixels'));
    expect(errored.screenshotSha256).toBeUndefined();
    expect(skipped.screenshotSha256).toBeUndefined();
    expect(unconfirmed.screenshotSha256).toBeUndefined();
  });

  it('leaves an unreadable file unstamped and never recomputes an existing stamp', () => {
    const dir = tmp();
    const missing = render({ screenshotPath: resolve(dir, 'nope.png') });
    const stamped = render({
      screenshotPath: png(dir, 'changed.png', 'NEW bytes'),
      screenshotSha256: 'recorded-earlier',
    });
    stampScreenshotHashes([missing, stamped]);
    expect(missing.screenshotSha256).toBeUndefined();
    expect(stamped.screenshotSha256).toBe('recorded-earlier'); // file may have moved on
  });
});

describe('buildRenderIdentity — recorded-hash pruning fallback', () => {
  it('proves identity via the recorded hash when the previous PNG is pruned', () => {
    // Previous and current runs use DIFFERENT dirs with the SAME basename —
    // the basename is the cross-run render key.
    const dir = tmp();
    const bytes = 'same pixels';
    const prevShot = png(resolve(dir, 'prev'), 'Comp__base.png', bytes);
    const prev = prevMeta([{ id: 'Comp', screenshotPath: prevShot, screenshotSha256: sha(bytes) }]);
    // Prune the previous run's file — only the recorded hash survives.
    unlinkSync(prevShot);
    const index = buildPrevRenderIndex(prev, { hash: 'h1' })!;
    const current = render({ screenshotPath: png(resolve(dir, 'cur'), 'Comp__base.png', bytes) });
    const { identity } = buildRenderIdentity([current], index);
    expect(identity.get('Comp__base')).toBe(true);
  });

  it('recorded hash mismatch reads false (pixels changed), not unknown', () => {
    const dir = tmp();
    const prevShot = png(resolve(dir, 'prev'), 'Comp__base.png', 'old pixels');
    const prev = prevMeta([
      { id: 'Comp', screenshotPath: prevShot, screenshotSha256: sha('old pixels') },
    ]);
    unlinkSync(prevShot);
    const index = buildPrevRenderIndex(prev, { hash: 'h1' })!;
    const current = render({
      screenshotPath: png(resolve(dir, 'cur'), 'Comp__base.png', 'new pixels'),
    });
    const { identity } = buildRenderIdentity([current], index);
    expect(identity.get('Comp__base')).toBe(false);
  });

  it('pruned previous PNG with NO recorded hash stays unknown (pre-hash run-metas)', () => {
    const dir = tmp();
    const prevShot = png(resolve(dir, 'prev'), 'Comp__base.png', 'pixels');
    const prev = prevMeta([{ id: 'Comp', screenshotPath: prevShot }]);
    unlinkSync(prevShot);
    const index = buildPrevRenderIndex(prev, { hash: 'h1' })!;
    const current = render({
      screenshotPath: png(resolve(dir, 'cur'), 'Comp__base.png', 'pixels'),
    });
    const { identity } = buildRenderIdentity([current], index);
    expect(identity.get('Comp__base')).toBe('unknown');
  });

  it('unreadable CURRENT file stays unknown even with a recorded hash', () => {
    const dir = tmp();
    const prevShot = png(resolve(dir, 'prev'), 'Comp__base.png', 'pixels');
    const prev = prevMeta([
      { id: 'Comp', screenshotPath: prevShot, screenshotSha256: sha('pixels') },
    ]);
    unlinkSync(prevShot);
    const index = buildPrevRenderIndex(prev, { hash: 'h1' })!;
    // Same basename/key, but the current file was never written.
    const current = render({ screenshotPath: resolve(dir, 'cur', 'Comp__base.png') });
    const { identity } = buildRenderIdentity([current], index);
    expect(identity.get('Comp__base')).toBe('unknown');
  });
});

describe('renderUnchangedForFold — end to end with pruning', () => {
  it('still proves renderUnchanged after the previous run dir is pruned', () => {
    const dir = tmp();
    const bytes = 'stable pixels';
    const prevShot = png(resolve(dir, 'prev'), 'Comp__base.png', bytes);
    const prev = prevMeta([{ id: 'Comp', screenshotPath: prevShot, screenshotSha256: sha(bytes) }]);
    unlinkSync(prevShot);
    const current = [render({ screenshotPath: png(resolve(dir, 'cur'), 'Comp__base.png', bytes) })];
    expect(renderUnchangedForFold(current, prev, { hash: 'h1' })).toBe(true);
  });

  it('returns undefined (never false) when nothing is provable', () => {
    const dir = tmp();
    const prevShot = png(resolve(dir, 'prev'), 'Comp__base.png', 'pixels');
    const prev = prevMeta([{ id: 'Comp', screenshotPath: prevShot }]);
    unlinkSync(prevShot); // pruned, no recorded hash
    const current = [
      render({ screenshotPath: png(resolve(dir, 'cur'), 'Comp__base.png', 'pixels') }),
    ];
    expect(renderUnchangedForFold(current, prev, { hash: 'h1' })).toBeUndefined();
  });
});

describe('renderUnchangedForFold — per-spec target scoping', () => {
  const stable = 'stable target pixels';

  // A previous run carrying BOTH the target and a sibling, files on disk.
  function prevWithTargetAndSibling(dir: string, targetId: string, siblingId: string): RunMeta {
    return prevMeta([
      {
        id: targetId,
        screenshotPath: png(resolve(dir, 'prev'), `${targetId}__base.png`, stable),
        screenshotSha256: sha(stable),
      },
      {
        id: siblingId,
        screenshotPath: png(resolve(dir, 'prev'), `${siblingId}__base.png`, 'old sibling'),
        screenshotSha256: sha('old sibling'),
      },
    ]);
  }

  it('proves true when the target render is identical even though a sibling render CHANGED', () => {
    const dir = tmp();
    const prev = prevWithTargetAndSibling(dir, 'Comp', 'Sibling');
    const current = [
      render({
        id: 'Comp',
        filePath: 'src/Comp.tsx',
        screenshotPath: png(resolve(dir, 'cur'), 'Comp__base.png', stable),
      }),
      render({
        id: 'Sibling',
        filePath: 'src/Sibling.tsx',
        screenshotPath: png(resolve(dir, 'cur'), 'Sibling__base.png', 'BRAND NEW sibling pixels'),
      }),
    ];
    expect(
      renderUnchangedForFold(current, prev, { hash: 'h1', targets: { components: ['Comp'] } }),
    ).toBe(true);
  });

  it('proves true when a sibling render ERRORED (not evidence) but the target is identical', () => {
    const dir = tmp();
    const prev = prevWithTargetAndSibling(dir, 'Comp', 'Sibling');
    const current = [
      render({
        id: 'Comp',
        filePath: 'src/Comp.tsx',
        screenshotPath: png(resolve(dir, 'cur'), 'Comp__base.png', stable),
      }),
      render({
        id: 'Sibling',
        filePath: 'src/Sibling.tsx',
        screenshotPath: resolve(dir, 'cur', 'Sibling__base.png'), // never written
        renderError: 'boom',
      }),
    ];
    expect(
      renderUnchangedForFold(current, prev, { hash: 'h1', targets: { components: ['Comp'] } }),
    ).toBe(true);
  });

  it('returns undefined when the TARGET render changed, regardless of an identical sibling', () => {
    const dir = tmp();
    const prev = prevWithTargetAndSibling(dir, 'Comp', 'Sibling');
    const current = [
      render({
        id: 'Comp',
        filePath: 'src/Comp.tsx',
        screenshotPath: png(resolve(dir, 'cur'), 'Comp__base.png', 'TARGET CHANGED pixels'),
      }),
      // Sibling is byte-identical to prev, but it is not a target — its silence
      // must never launder the changed target into a `true`.
      render({
        id: 'Sibling',
        filePath: 'src/Sibling.tsx',
        screenshotPath: png(resolve(dir, 'cur'), 'Sibling__base.png', 'old sibling'),
      }),
    ];
    expect(
      renderUnchangedForFold(current, prev, { hash: 'h1', targets: { components: ['Comp'] } }),
    ).toBeUndefined();
  });

  it('returns undefined when NO target render is present in the current set', () => {
    const dir = tmp();
    const prev = prevWithTargetAndSibling(dir, 'Comp', 'Sibling');
    const current = [
      render({
        id: 'Sibling',
        filePath: 'src/Sibling.tsx',
        screenshotPath: png(resolve(dir, 'cur'), 'Sibling__base.png', 'old sibling'),
      }),
    ];
    expect(
      renderUnchangedForFold(current, prev, { hash: 'h1', targets: { components: ['Comp'] } }),
    ).toBeUndefined();
  });

  it('matches a nested-path target by basename against an absolute render filePath', () => {
    const dir = tmp();
    const prev = prevMeta([
      {
        id: 'ContactForm',
        screenshotPath: png(resolve(dir, 'prev'), 'ContactForm__base.png', stable),
        screenshotSha256: sha(stable),
      },
    ]);
    const current = [
      render({
        id: 'ContactForm',
        // absolute path, as the web isolation path stamps it
        filePath: '/abs/project/src/components/forms/ContactForm.tsx',
        screenshotPath: png(resolve(dir, 'cur'), 'ContactForm__base.png', stable),
      }),
    ];
    expect(
      renderUnchangedForFold(current, prev, {
        hash: 'h1',
        targets: { components: ['src/components/forms/ContactForm.tsx'] },
      }),
    ).toBe(true);
  });

  it('with NO declared targets, falls back to the whole set (a dirty sibling still stales)', () => {
    const dir = tmp();
    const prev = prevWithTargetAndSibling(dir, 'Comp', 'Sibling');
    const current = [
      render({
        id: 'Comp',
        filePath: 'src/Comp.tsx',
        screenshotPath: png(resolve(dir, 'cur'), 'Comp__base.png', stable),
      }),
      render({
        id: 'Sibling',
        filePath: 'src/Sibling.tsx',
        screenshotPath: png(resolve(dir, 'cur'), 'Sibling__base.png', 'NEW sibling pixels'),
      }),
    ];
    // No targets ⇒ can't scope ⇒ pre-scoping behavior: the changed sibling
    // keeps the fold from proving identity.
    expect(renderUnchangedForFold(current, prev, { hash: 'h1' })).toBeUndefined();
  });
});

describe('screenshotsIdentical', () => {
  it('true on matching bytes, false on differing, unknown on unreadable', () => {
    const dir = tmp();
    const a = png(dir, 'a.png', 'x');
    const b = png(dir, 'b.png', 'x');
    const c = png(dir, 'c.png', 'y');
    expect(screenshotsIdentical(a, b)).toBe(true);
    expect(screenshotsIdentical(a, c)).toBe(false);
    expect(screenshotsIdentical(a, resolve(dir, 'missing.png'))).toBe('unknown');
  });
});
