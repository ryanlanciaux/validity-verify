import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// post-check.cjs is dependency-free CommonJS; require it through createRequire so
// the default export (the async `post` fn) and its attached pure builders both
// resolve without any ESM interop guesswork.
const require = createRequire(import.meta.url);
const post = require('./post-check.cjs') as any;
const {
  conclusionFor,
  commentBody,
  compactBody,
  fatBody,
  badgesLine,
  scoreLine,
  specCensusLine,
  provenSection,
  scoredSection,
  notValidatedSection,
  baseSection,
  capRows,
  escapeCell,
  codeSpan,
  clip,
  MAX_BODY,
  checkTitle,
  envBlockedCallout,
  envBlockedCount,
  summaryLine,
} = post;

// ── Fixture builders ──

function crit(over: any = {}): any {
  return {
    id: over.id ?? 'AC-1',
    text: over.text ?? 'Renders the thing',
    tier: over.tier ?? 'hard',
    status: over.status ?? 'pass',
    ...over,
  };
}

function spec(over: any = {}): any {
  return {
    specId: over.specId ?? 'spec-a',
    version: over.version ?? 1,
    criteria: over.criteria ?? [crit()],
    ...over,
  };
}

/** A v1-shaped meta (no `specs`) — what an old CLI writes. */
function metaV1(over: any = {}): any {
  return {
    verdict: over.verdict ?? 'partial',
    pass: over.pass ?? true,
    coveragePercent: over.coveragePercent ?? 80,
    counts: over.counts ?? { pass: 3, fail: 0, unverifiable: 1, skipped: 2 },
    repo: over.repo ?? 'acme/app',
    sha: over.sha ?? 'deadbeef',
    specHash: over.specHash ?? 'hash123',
    branch: over.branch ?? 'feature',
    prNumber: over.prNumber ?? 7,
    ...over,
  };
}

/** A v2-shaped meta (carries `specs`). */
function metaV2(over: any = {}): any {
  return {
    ...metaV1(over),
    schemaVersion: 2,
    specs: over.specs ?? [spec()],
    ...over,
  };
}

// ── 1. conclusionFor (regression guard, v1 + v2 shaped) ──

describe('conclusionFor', () => {
  it('maps hard fail / coverage breach to failure', () => {
    expect(conclusionFor(metaV1({ pass: false, verdict: 'fail' }))).toBe('failure');
    expect(conclusionFor(metaV2({ pass: false, verdict: 'fail' }))).toBe('failure');
  });
  it('maps a clean pass to success', () => {
    expect(conclusionFor(metaV1({ pass: true, verdict: 'pass' }))).toBe('success');
  });
  it('maps a green-but-partial run to neutral (never a clean green)', () => {
    expect(conclusionFor(metaV1({ pass: true, verdict: 'partial' }))).toBe('neutral');
    expect(conclusionFor(metaV2({ pass: true, verdict: 'partial' }))).toBe('neutral');
  });
});

// ── 2. Fat / compact dispatch + backward compatibility ──

describe('commentBody dispatch', () => {
  it('renders the compact body verbatim for v1 meta (no specs)', () => {
    const m = metaV1();
    expect(commentBody(m, 'http://art', 'full')).toBe(compactBody(m, 'http://art'));
  });

  it('v1 compact body matches the historical golden string', () => {
    const m = metaV1({
      verdict: 'partial',
      pass: true,
      coveragePercent: 80,
      counts: { pass: 3, fail: 0, unverifiable: 1, skipped: 2 },
    });
    const expected = [
      '<!-- validity-report -->',
      '## Validity — deterministic spec gate',
      '',
      '**PARTIAL — 3 pass · 0 fail · 1 unverifiable · 2 soft (advisory) · coverage 80%**',
      '',
      "📎 [Download the full report](http://art) (screenshots + diff — in **your** repo's GitHub artifacts).",
      '',
      '✅ Every proof held and coverage met the floor.',
      '',
      '> Soft (aesthetic) criteria are advisory and never block — they need an agent verify to score.',
    ].join('\n');
    expect(compactBody(m, 'http://art')).toBe(expected);
  });

  it('forces compact when COMMENT_DETAIL=compact even with v2 meta', () => {
    const m = metaV2();
    expect(commentBody(m, '', 'compact')).toBe(compactBody(m, ''));
    expect(commentBody(m, '', 'compact')).not.toContain('### Proven');
  });

  it('renders the fat body when v2 specs present and detail is full', () => {
    const m = metaV2();
    const body = commentBody(m, '', 'full');
    expect(body).toContain('### Proven (deterministic)');
    expect(body.startsWith('<!-- validity-report -->')).toBe(true);
  });

  it('renders compact when specs is an empty array (nothing to table)', () => {
    const m = metaV2({ specs: [] });
    expect(commentBody(m, '', 'full')).toBe(compactBody(m, ''));
  });
});

// ── 3. Header + badges + score line ──

describe('fat header, badges, score', () => {
  it('header reflects the verdict emoji', () => {
    expect(fatBody(metaV2({ verdict: 'fail' }), '')).toContain('## Validity — ❌ FAIL');
    expect(fatBody(metaV2({ verdict: 'pass' }), '')).toContain('## Validity — ✅ PASS');
    expect(fatBody(metaV2({ verdict: 'partial' }), '')).toContain('## Validity — ⚠️ PARTIAL');
  });

  it('badges line renders only present fields', () => {
    expect(badgesLine(metaV2())).toBeNull();
    expect(badgesLine(metaV2({ unplanned: true }))).toBe(
      '`UNPLANNED — criteria extracted after the work`',
    );
    expect(badgesLine(metaV2({ enforcement: 'strict' }))).toBe('`strict`');
    expect(badgesLine(metaV2({ enforcement: 'advisory' }))).toBeNull();
  });

  it('temporal badge picks the worst classification across specs', () => {
    const specs = [
      spec({ specId: 'a', temporal: 'frozen-before-work' }),
      spec({ specId: 'b', temporal: 'frozen-mid-work' }),
    ];
    expect(badgesLine(metaV2({ specs }))).toBe('`spec frozen mid-work`');
    const clean = [spec({ specId: 'a', temporal: 'frozen-before-work' })];
    expect(badgesLine(metaV2({ specs: clean }))).toBe('`spec frozen before work`');
  });

  // Regression: temporal badge vocabulary inconsistency — the PR comment must
  // speak the HTML report's pill labels ('spec frozen before work' / 'spec
  // frozen mid-work' / 'spec timing unknown'), never the raw enum or a lone
  // bare word, and an unrecognized value must never read as the good case.
  it('partial unknown keeps the known classification and names the unknown count', () => {
    const specs = [
      spec({ specId: 'a', temporal: 'frozen-before-work' }),
      spec({ specId: 'b', temporal: 'unknown' }),
    ];
    expect(badgesLine(metaV2({ specs }))).toBe('`spec frozen before work (1 spec unknown)`');
    const two = [
      spec({ specId: 'a', temporal: 'frozen-mid-work' }),
      spec({ specId: 'b', temporal: 'unknown' }),
      spec({ specId: 'c', temporal: 'garbage-value' }),
    ];
    expect(badgesLine(metaV2({ specs: two }))).toBe('`spec frozen mid-work (2 specs unknown)`');
  });

  it('temporal badge uses the report pill vocabulary, incl. the unknown case', () => {
    expect(badgesLine(metaV2({ specs: [spec({ temporal: 'unknown' })] }))).toBe(
      '`spec timing unknown`',
    );
    // an unclassifiable/garbage value is unknown, never promoted to frozen-before-work
    expect(badgesLine(metaV2({ specs: [spec({ temporal: 'garbage-value' })] }))).toBe(
      '`spec timing unknown`',
    );
    const body = fatBody(metaV2({ specs: [spec({ temporal: 'frozen-mid-work' })] }), '');
    expect(body).toContain('`spec frozen mid-work`');
    expect(body).not.toContain('`frozen-mid-work`');
  });

  it('score line shows current, and delta vs base when present', () => {
    expect(scoreLine(metaV2({ validityScore: { current: 84, scoreVersion: 1 } }))).toBe(
      '**Validity Score: 84**',
    );
    expect(scoreLine(metaV2({ validityScore: { current: 84, base: 87, scoreVersion: 1 } }))).toBe(
      '**Validity Score: 84 (base 87 · ▼3)**',
    );
    expect(scoreLine(metaV2({ validityScore: { current: 90, base: 87, scoreVersion: 1 } }))).toBe(
      '**Validity Score: 90 (base 87 · ▲3)**',
    );
    // null current ⇒ no line (F1 hasn't scored yet)
    expect(scoreLine(metaV2({ validityScore: { current: null, scoreVersion: 1 } }))).toBeNull();
  });
});

// ── 4. Proven section ──

describe('provenSection', () => {
  it('orders fail → unverifiable → pass, stable within a band', () => {
    const s = spec({
      criteria: [
        crit({ id: 'AC-1', status: 'pass' }),
        crit({ id: 'AC-2', status: 'fail' }),
        crit({ id: 'AC-3', status: 'unverifiable' }),
        crit({ id: 'AC-4', status: 'pass' }),
      ],
    });
    const lines = provenSection(metaV2({ specs: [s] })).join('\n');
    const iFail = lines.indexOf('AC-2');
    const iUnver = lines.indexOf('AC-3');
    const iPass1 = lines.indexOf('AC-1');
    const iPass4 = lines.indexOf('AC-4');
    expect(iFail).toBeLessThan(iUnver);
    expect(iUnver).toBeLessThan(iPass1);
    expect(iPass1).toBeLessThan(iPass4); // stable within the pass band
  });

  it('omits the Spec column for a single spec, includes it for multiple', () => {
    const single = provenSection(metaV2({ specs: [spec()] })).join('\n');
    expect(single).toContain('| Criterion | Tier | Result | Evidence | Detail |');
    const multi = provenSection(
      metaV2({ specs: [spec({ specId: 'a' }), spec({ specId: 'b' })] }),
    ).join('\n');
    expect(multi).toContain('| Spec | Criterion | Tier | Result | Evidence | Detail |');
    expect(multi).toContain('`a@v1`');
  });

  it('renders taint labels in the Evidence column and never a ✅ on a non-pass row', () => {
    const s = spec({
      criteria: [crit({ id: 'AC-9', status: 'unverifiable', taints: ['network'] })],
    });
    const line = provenSection(metaV2({ specs: [s] })).join('\n');
    expect(line).toContain('⛓ network');
    expect(line).toContain('⚠️ unverifiable');
    // the row for a tainted-unverifiable criterion must not carry the pass badge
    const row = line.split('\n').find((l) => l.includes('AC-9'))!;
    expect(row).not.toContain('✅');
  });

  it('handles zero hard/property criteria', () => {
    const s = spec({ criteria: [crit({ tier: 'soft', status: 'skipped' })] });
    const out = provenSection(metaV2({ specs: [s] })).join('\n');
    expect(out).toContain('_No hard or property criteria in the frozen specs._');
  });
});

// ── 4b. Spec census (W6 #23) ──

describe('specCensusLine', () => {
  it('is null when there is no census', () => {
    expect(specCensusLine(metaV2())).toBeNull();
  });

  it('is null when nothing is untracked', () => {
    expect(
      specCensusLine(metaV2({ specCensus: { verified: 3, total: 3, untracked: 0 } })),
    ).toBeNull();
  });

  it('warns and names the tracked/total split when frozen specs are untracked', () => {
    const line = specCensusLine(metaV2({ specCensus: { verified: 2, total: 3, untracked: 1 } }));
    expect(line).toContain('1 of 3 frozen spec(s) are untracked');
    // 3 total − 1 untracked = 2 committed ones CI actually verified.
    expect(line).toContain('only the 2 committed one(s)');
    expect(line).toContain('git add');
  });

  it('appears in the fat body above the proven section when untracked > 0', () => {
    const body = fatBody(metaV2({ specCensus: { verified: 0, total: 2, untracked: 2 } }), null);
    expect(body).toContain('2 of 2 frozen spec(s) are untracked');
    expect(body.indexOf('frozen spec(s) are untracked')).toBeLessThan(body.indexOf('### Proven'));
  });
});

// ── 5. Scored section ──

describe('scoredSection', () => {
  it('is omitted when there are no soft criteria', () => {
    expect(scoredSection(metaV2({ specs: [spec()] }))).toBeNull();
  });

  it('renders judge badges (self ⇒ self-scored, absent ⇒ —)', () => {
    const s = spec({
      criteria: [
        crit({ id: 'AC-7', tier: 'soft', status: 'skipped', judge: 'self' }),
        crit({ id: 'AC-8', tier: 'soft', status: 'skipped' }),
      ],
    });
    const out = scoredSection(metaV2({ specs: [s] }))!.join('\n');
    expect(out).toContain('⚠️ self-scored');
    expect(out).toContain('⏭️ not scored in CI');
    const row8 = out.split('\n').find((l) => l.includes('AC-8'))!;
    expect(row8).toContain('| — |');
  });
});

// ── 6. Not-validated section ──

describe('notValidatedSection', () => {
  it('groups unverifiable rows by taint reason, sorted by size desc', () => {
    const s = spec({
      specId: 'spec-a',
      criteria: [
        crit({ id: 'AC-4', status: 'unverifiable', taints: ['network'] }),
        crit({ id: 'AC-9', status: 'unverifiable', taints: ['network'] }),
        crit({ id: 'AC-2', status: 'unverifiable', detail: 'no mechanical verdict produced' }),
      ],
    });
    const out = notValidatedSection(
      metaV2({
        specs: [s],
        counts: { pass: 0, fail: 0, unverifiable: 3, skipped: 0 },
        coveragePercent: 0,
      }),
    ).join('\n');
    expect(out).toContain('**network-tainted (2):** `spec-a/AC-4`, `spec-a/AC-9`');
    expect(out).toContain('**no mechanical verdict (1):** `spec-a/AC-2`');
    // larger group first
    expect(out.indexOf('network-tainted')).toBeLessThan(out.indexOf('no mechanical verdict'));
  });

  it('renders a render-error bullet and a soft-count bullet', () => {
    const s = spec({
      specId: 'spec-c',
      version: 1,
      error: 'Vite sandbox failed: boom',
      criteria: [],
    });
    const out = notValidatedSection(
      metaV2({ specs: [s], counts: { pass: 0, fail: 0, unverifiable: 0, skipped: 5 } }),
    ).join('\n');
    expect(out).toContain('**render error (1 spec):** `spec-c@v1` — Vite sandbox failed: boom');
    expect(out).toContain('**soft — not scored in CI (5):**');
    // Derive posture (W6 #21/#23): the bullet nudges the committed channel.
    expect(out).toContain('historyCommitted: true');
  });

  it('shows the honest empty-remainder line when nothing is unverifiable', () => {
    const out = notValidatedSection(
      metaV2({
        specs: [spec()],
        counts: { pass: 4, fail: 0, unverifiable: 0, skipped: 0 },
        coveragePercent: 100,
      }),
    ).join('\n');
    expect(out).toContain('nothing unverifiable');
  });

  it('reports coverage as unmeasurable when coveragePercent is null', () => {
    const out = notValidatedSection(metaV2({ specs: [spec()], coveragePercent: null })).join('\n');
    expect(out).toContain('Coverage unmeasurable');
  });
});

// ── 7. Base-comparison section ──

describe('baseSection', () => {
  it('is omitted entirely when meta.base is absent', () => {
    expect(baseSection(metaV2())).toBeNull();
  });

  it('renders the no-history hint when base.specs is empty', () => {
    const out = baseSection(metaV2({ base: { sha: 'abc1234def', specs: [] } }))!.join('\n');
    expect(out).toContain('### Changes vs base `abc1234`');
    expect(out).toContain('No Validity run history found at the merge-base');
    expect(out).toContain('fetch-depth: 0');
  });

  it('renders regressed before recovered, then a summary count', () => {
    const base = {
      sha: 'abc1234def',
      specs: [
        {
          specId: 'spec-a',
          baseSpecVersion: 1,
          baseRunId: 'r1',
          baseCreatedAt: '2026-06-01',
          deltas: [
            {
              criterionId: 'AC-3',
              previousStatus: 'pass',
              currentStatus: 'fail',
              delta: 'regressed',
            },
            {
              criterionId: 'AC-5',
              previousStatus: 'unverifiable',
              currentStatus: 'pass',
              delta: 'improved',
            },
            {
              criterionId: 'AC-1',
              previousStatus: 'pass',
              currentStatus: 'pass',
              delta: 'unchanged',
            },
            { criterionId: 'AC-9', currentStatus: 'pass', delta: 'new' },
          ],
        },
      ],
    };
    const out = baseSection(
      metaV2({ specs: [spec({ specId: 'spec-a', version: 1 })], base }),
    )!.join('\n');
    expect(out.indexOf('regressed')).toBeLessThan(out.indexOf('recovered'));
    expect(out).toContain('❌ **regressed:** `spec-a/AC-3` pass → fail');
    expect(out).toContain('✅ **recovered:** `spec-a/AC-5` unverifiable → pass');
    expect(out).toContain('1 unchanged · 1 new since base');
  });

  it('adds a version-span caveat when the base spec version differs', () => {
    const base = {
      sha: 'abc1234',
      specs: [
        { specId: 'spec-a', baseSpecVersion: 1, baseRunId: 'r1', baseCreatedAt: 'x', deltas: [] },
      ],
    };
    // current spec is v2, base entry is v1 ⇒ caveat
    const out = baseSection(
      metaV2({ specs: [spec({ specId: 'spec-a', version: 2 })], base }),
    )!.join('\n');
    expect(out).toContain('deltas span versions');
  });
});

// ── 7b. Environment-blocked attribution (never-false-green: attribution, not softening) ──

describe('envBlocked attribution', () => {
  it('envBlockedCount is 0 when the field is absent (older CLI) or empty', () => {
    expect(envBlockedCount(metaV2())).toBe(0);
    expect(envBlockedCount(metaV2({ envBlocked: { count: 0, errors: [] } }))).toBe(0);
  });

  it('envBlockedCount reads meta.envBlocked.count when present and positive', () => {
    expect(
      envBlockedCount(metaV2({ envBlocked: { count: 2, errors: ['Vite sandbox failed: boom'] } })),
    ).toBe(2);
  });

  it('checkTitle is unchanged when envBlocked is absent', () => {
    expect(checkTitle(metaV1({ verdict: 'fail' }))).toBe('Validity — fail');
    expect(checkTitle(metaV2({ verdict: 'pass' }))).toBe('Validity — pass');
  });

  it('checkTitle names the environment-blocked count alongside the verdict', () => {
    const m = metaV2({
      verdict: 'fail',
      envBlocked: { count: 3, errors: ['boom'] },
    });
    expect(checkTitle(m)).toBe('Validity — fail (environment blocked — 3 specs)');
  });

  it('checkTitle singularizes for exactly 1 spec', () => {
    const m = metaV2({ verdict: 'fail', envBlocked: { count: 1, errors: ['boom'] } });
    expect(checkTitle(m)).toBe('Validity — fail (environment blocked — 1 spec)');
  });

  it('summaryLine is unchanged when envBlocked is absent (backward compat)', () => {
    const m = metaV1({
      verdict: 'partial',
      coveragePercent: 80,
      counts: { pass: 3, fail: 0, unverifiable: 1, skipped: 2 },
    });
    expect(summaryLine(m)).toBe(
      'PARTIAL — 3 pass · 0 fail · 1 unverifiable · 2 soft (advisory) · coverage 80%',
    );
  });

  it('summaryLine appends the environment-blocked count when present', () => {
    const m = metaV2({
      verdict: 'fail',
      coveragePercent: 40,
      counts: { pass: 1, fail: 0, unverifiable: 3, skipped: 0 },
      envBlocked: { count: 2, errors: ['Vite sandbox failed: boom'] },
    });
    expect(summaryLine(m)).toContain('2 environment-blocked');
  });

  it('envBlockedCallout is null when the field is absent or empty', () => {
    expect(envBlockedCallout(metaV2())).toBeNull();
    expect(envBlockedCallout(metaV2({ envBlocked: { count: 0, errors: [] } }))).toBeNull();
  });

  it('envBlockedCallout lists the count and deduped error reasons', () => {
    const m = metaV2({
      envBlocked: { count: 2, errors: ['Vite sandbox failed: boom', 'timeout waiting for render'] },
    });
    const out = envBlockedCallout(m).join('\n');
    expect(out).toContain('Environment blocked — 2 specs produced no verdicts');
    expect(out).toContain('Vite sandbox failed: boom');
    expect(out).toContain('timeout waiting for render');
    expect(out).toContain('may be environmental');
  });

  it('envBlockedCallout names the cause + first-line fix when `causes` is present', () => {
    const m = metaV2({
      envBlocked: {
        count: 1,
        errors: ['native verify: render not confirmed'],
        causes: [
          {
            error: 'native verify: render not confirmed',
            cause: 'session-decay',
            fixCommand: 'kill $(cat daemon.pid)\nadb emu kill',
          },
        ],
      },
    });
    const out = envBlockedCallout(m).join('\n');
    expect(out).toContain('cause: `session-decay`');
    // A PR comment is not where a four-line reset gets run.
    expect(out).toContain('fix: `kill $(cat daemon.pid)`');
    expect(out).not.toContain('adb emu kill');
  });

  it('envBlockedCallout renders byte-identically when `causes` is absent (older CLI)', () => {
    const withoutCauses = envBlockedCallout(
      metaV2({ envBlocked: { count: 1, errors: ['boom'] } }),
    ).join('\n');
    expect(withoutCauses).toContain('> - boom');
    expect(withoutCauses).not.toContain('cause:');
  });

  it('envBlockedCallout leaves an error with no matching cause entry unannotated', () => {
    const out = envBlockedCallout(
      metaV2({
        envBlocked: {
          count: 2,
          errors: ['diagnosed', 'undiagnosed'],
          causes: [{ error: 'diagnosed', cause: 'foreign-metro' }],
        },
      }),
    ).join('\n');
    expect(out).toContain('> - diagnosed — cause: `foreign-metro`');
    expect(out).toContain('> - undiagnosed');
    // No fix clause when the diagnosis carried no command.
    expect(out).not.toContain('fix:');
  });

  it('envBlockedCallout caps shown errors at 5 with an overflow note', () => {
    const errors = Array.from({ length: 8 }, (_, i) => `error-${i}`);
    const out = envBlockedCallout(metaV2({ envBlocked: { count: 8, errors } })).join('\n');
    for (let i = 0; i < 5; i++) expect(out).toContain(`error-${i}`);
    expect(out).toContain('…and 3 more distinct error(s)');
  });

  it('compactBody renders unchanged when envBlocked is absent (backward compat)', () => {
    const m = metaV1();
    expect(compactBody(m, 'http://art')).not.toContain('Environment blocked');
  });

  it('compactBody prepends the callout when envBlocked is present, before the summary line', () => {
    const m = metaV1({
      verdict: 'fail',
      pass: false,
      envBlocked: { count: 1, errors: ['boom'] },
    });
    const body = compactBody(m, '');
    expect(body).toContain('⚠ **Environment blocked — 1 spec produced no verdicts.**');
    expect(body.indexOf('Environment blocked')).toBeLessThan(body.indexOf(`**${summaryLine(m)}**`));
  });

  it('fatBody renders unchanged when envBlocked is absent (backward compat)', () => {
    const m = metaV2();
    expect(fatBody(m, '')).not.toContain('Environment blocked');
  });

  it('fatBody prepends the callout right after the header, before badges/score', () => {
    const m = metaV2({
      verdict: 'fail',
      pass: false,
      envBlocked: { count: 2, errors: ['boom'] },
      enforcement: 'strict',
    });
    const body = fatBody(m, '');
    const iHeader = body.indexOf('## Validity —');
    const iCallout = body.indexOf('Environment blocked');
    const iBadge = body.indexOf('`strict`');
    expect(iHeader).toBeLessThan(iCallout);
    expect(iCallout).toBeLessThan(iBadge);
  });

  it('conclusion stays failure regardless of envBlocked — attribution, never softening', () => {
    const m = metaV2({ pass: false, verdict: 'fail', envBlocked: { count: 3, errors: ['boom'] } });
    expect(conclusionFor(m)).toBe('failure');
  });
});

// ── 8. capRows determinism + overflow ──

describe('capRows', () => {
  it('keeps all rows when they fit', () => {
    const rows = ['a', 'b', 'c'];
    expect(capRows(rows, 1000, 'rows')).toEqual(rows);
  });

  it('emits an overflow line with the exact omitted count when over budget', () => {
    const rows = Array.from({ length: 100 }, (_, i) => 'x'.repeat(50) + i);
    const out = capRows(rows, 300, 'rows');
    const overflow = out[out.length - 1];
    expect(overflow).toMatch(/^_…and \d+ more rows — see the report artifact\._$/);
    const omitted = Number(overflow.match(/and (\d+) more/)![1]);
    expect(omitted).toBe(100 - (out.length - 1));
  });
});

// ── 9. Truncation: determinism + hard body bound ──

describe('truncation', () => {
  function bigMeta(n: number): any {
    const criteria = Array.from({ length: n }, (_, i) =>
      crit({
        id: `AC-${i}`,
        text: 'lorem ipsum '.repeat(40) + i, // long text, clipped to 100
        status: i % 3 === 0 ? 'fail' : i % 3 === 1 ? 'unverifiable' : 'pass',
        tier: 'hard',
        taints: i % 3 === 1 ? ['network'] : undefined,
        detail: 'detail '.repeat(40),
      }),
    );
    return metaV2({
      verdict: 'fail',
      pass: false,
      specs: [spec({ criteria }), spec({ specId: 'spec-b', criteria: criteria.slice(0, 20) })],
      counts: { pass: n, fail: n, unverifiable: n, skipped: 0 },
    });
  }

  it('is byte-identical across two renders of the same meta', () => {
    const m = bigMeta(400);
    expect(commentBody(m, 'http://art', 'full')).toBe(commentBody(m, 'http://art', 'full'));
  });

  it('never exceeds GitHub’s hard limit for a 400-criterion meta', () => {
    const body = commentBody(bigMeta(400), 'http://art', 'full');
    expect(body.length).toBeLessThanOrEqual(MAX_BODY);
  });

  it('escapes pipes and newlines so table rows are not broken', () => {
    const s = spec({
      criteria: [
        crit({ id: 'AC-x', text: 'a | b\nc', tier: 'hard', status: 'fail', detail: 'x|y\nz' }),
      ],
    });
    const body = fatBody(metaV2({ specs: [s], verdict: 'fail', pass: false }), '');
    const row = body.split('\n').find((l) => l.includes('AC-x'))!;
    // one literal cell separator budget: pipes inside content are escaped
    expect(row).toContain('a \\| b c');
    expect(row).toContain('x\\|y z');
    expect(row).not.toContain('\n'); // (row is already a single split line, sanity)
  });
});

// ── 10. Can't-false-green battery ──

describe("can't false-green", () => {
  it('a hard fail survives truncation: fail row + FAIL header + failure conclusion', () => {
    // 1 hard fail buried under 500 huge pass rows.
    const passRows = Array.from({ length: 500 }, (_, i) =>
      crit({ id: `P-${i}`, text: 'z'.repeat(10000), status: 'pass', tier: 'hard' }),
    );
    const m = metaV2({
      verdict: 'fail',
      pass: false,
      specs: [
        spec({
          criteria: [
            crit({ id: 'THE-FAIL', text: 'Submit posts the form', status: 'fail', tier: 'hard' }),
            ...passRows,
          ],
        }),
      ],
      counts: { pass: 500, fail: 1, unverifiable: 0, skipped: 0 },
    });
    const body = commentBody(m, 'http://art', 'full');
    expect(body.length).toBeLessThanOrEqual(MAX_BODY);
    expect(body).toContain('THE-FAIL');
    expect(body).toContain('❌ fail');
    expect(body).toContain('## Validity — ❌ FAIL');
    expect(conclusionFor(m)).toBe('failure');
  });

  it('a tainted-unverifiable row never renders a ✅ badge anywhere', () => {
    const s = spec({
      criteria: [
        crit({ id: 'AC-1', status: 'unverifiable', taints: ['wrapper'] }),
        crit({ id: 'AC-2', status: 'unverifiable', taints: ['synthetic-data'] }),
      ],
    });
    const body = fatBody(
      metaV2({
        specs: [s],
        verdict: 'partial',
        pass: true,
        counts: { pass: 0, fail: 0, unverifiable: 2, skipped: 0 },
      }),
      '',
    );
    // no green check anywhere except the pass-footer sentence (guarded: pass:true here)
    // isolate the Proven table region and assert no ✅ badge on those rows
    const provenRows = body.split('\n').filter((l) => l.startsWith('| AC-'));
    for (const r of provenRows) expect(r).not.toContain('✅');
  });

  it('the > MAX_BODY guard falls back to the compact body, which still names the fail', () => {
    // The capped fat sections cannot exceed MAX_BODY on their own; a caller-supplied
    // giant artifactUrl is the only way to overflow, and it exercises the guard.
    const hugeUrl = 'http://x/' + 'q'.repeat(MAX_BODY + 10);
    const m = metaV2({ verdict: 'fail', pass: false });
    const body = commentBody(m, hugeUrl, 'full');
    expect(body).toBe(compactBody(m, hugeUrl)); // guard chose compact
    expect(body).toContain('❌ A hard/property check regressed');
  });
});

// ── 11. escapeCell / codeSpan / clip units ──

describe('escapeCell + codeSpan + clip', () => {
  it('escapeCell strips newlines, escapes pipes, trims', () => {
    expect(escapeCell('  a | b\nc  ')).toBe('a \\| b c');
    expect(escapeCell(null)).toBe('');
  });

  // Regression: escapeCell is not a markdown/HTML/@-mention escaper —
  // criterion text/id/detail rendered as active markup in the bot comment.
  it('escapeCell neutralizes HTML, code spans, links/images, and @-mentions', () => {
    expect(escapeCell('<img src="https://attacker/px.gif">')).toBe(
      '&lt;img src=&quot;https://attacker/px.gif&quot;&gt;',
    );
    expect(escapeCell('[looks green](javascript:x)')).toBe('&#91;looks green](javascript:x)');
    expect(escapeCell('`code`')).toBe('&#96;code&#96;');
    expect(escapeCell('cc @maintainer')).toBe('cc @\u200bmaintainer');
    expect(escapeCell("a & 'b'")).toBe('a &amp; &#39;b&#39;');
  });

  it('escapeCell defuses a planted upsert marker', () => {
    expect(escapeCell('x <!-- validity-report --> y')).not.toContain('<!-- validity-report -->');
  });

  // Regression: a backtick inside a code-span-wrapped id would CLOSE the span
  // and let the tail render as active markdown (backslashes don't escape
  // inside code spans) — codeSpan must strip it.
  it('codeSpan cannot be broken out of by a backtick in the value', () => {
    expect(codeSpan('a`<img src=x>`b')).toBe("`a'<img src=x>'b`");
    expect(codeSpan('id | x\ny')).toBe('`id \\| x y`');
    expect(codeSpan('')).toBe('` `');
  });

  it('clip adds an ellipsis only when over length', () => {
    expect(clip('abcde', 10)).toBe('abcde');
    expect(clip('abcdef', 3)).toBe('ab…');
  });
});

// ── 12. Injection hardening — adversarial battery ──
//
// Regression tests for: "baseSection interpolates criterionId/previousStatus/
// currentStatus into the bot PR comment with NO escaping" and "escapeCell is
// not a markdown/HTML/@-mention escaper". Every value here is attacker-
// authorable (spec.yaml criteria, committed runs.jsonl statuses) and the
// comment posts with the workflow's own token.

describe('injection hardening', () => {
  const MARKER = '<!-- validity-report -->';

  it('baseSection escapes history-authored statuses and criterion ids', () => {
    const payload = 'pass</code>\n\n# 🟢 All checks passed — safe to merge\n' + MARKER;
    const base = {
      sha: 'abc1234def',
      specs: [
        {
          specId: 'spec-a',
          baseSpecVersion: 1,
          baseRunId: 'r1',
          baseCreatedAt: 'x',
          deltas: [
            {
              criterionId: 'AC-`bad`',
              previousStatus: payload,
              currentStatus: 'fail',
              delta: 'regressed',
            },
          ],
        },
      ],
    };
    const out = baseSection(metaV2({ specs: [spec({ specId: 'spec-a' })], base }))!.join('\n');
    expect(out).not.toContain(MARKER); // marker spoof defused
    expect(out).toContain('pass&lt;/code&gt;'); // HTML entity-escaped, clipped
    expect(out).toContain('→ fail'); // known statuses still render verbatim
    // no attacker line ever starts an h1 heading (newlines flattened); the
    // section's own '### Changes vs base' h3 is the only heading present
    for (const line of out.split('\n')) expect(line.startsWith('# ')).toBe(false);
    // the criterion id cannot close its code span: exactly one span per bullet
    const bullet = out.split('\n').find((l) => l.includes('regressed'))!;
    expect(bullet).toContain("`spec-a/AC-'bad'`");
    expect((bullet.match(/`/g) || []).length).toBe(2);
  });

  it('criterion text cannot mention users, inject markup, or spoof the marker', () => {
    const s = spec({
      criteria: [
        crit({
          id: 'AC-evil',
          text: `cc @maintainer <img src=x> [ok](https://e) ${MARKER}`,
          status: 'fail',
          detail: 'see <script>@bob</script>',
        }),
      ],
    });
    const body = fatBody(metaV2({ specs: [s], verdict: 'fail', pass: false }), '');
    expect(body.indexOf(MARKER)).toBe(0); // the real marker leads…
    expect(body.lastIndexOf(MARKER)).toBe(0); // …and no spoofed copy survives
    expect(body).not.toContain('@maintainer'); // ZWSP-defused mention
    expect(body).toContain('@\u200bmaintainer');
    expect(body).not.toContain('<img');
    expect(body).not.toContain('<script>');
    expect(body).not.toContain('[ok]('); // link/image syntax defused
  });

  it('unknown taint / judge strings are escaped, and spec render errors too', () => {
    const s = spec({
      criteria: [
        crit({ id: 'AC-t', status: 'unverifiable', taints: ['<b>@evil</b>'] }),
        crit({ id: 'AC-j', tier: 'soft', status: 'skipped', judge: '<i>@judge</i>' }),
      ],
      error: `boom ${MARKER} @oncall`,
    });
    const body = fatBody(
      metaV2({ specs: [s], counts: { pass: 0, fail: 0, unverifiable: 1, skipped: 1 } }),
      '',
    );
    expect(body).not.toContain('<b>');
    expect(body).not.toContain('<i>');
    expect(body).not.toContain('@evil');
    expect(body).not.toContain('@judge');
    expect(body).not.toContain('@oncall');
    expect(body.lastIndexOf(MARKER)).toBe(0);
  });

  it('a long-text truncation attack never drops the FAIL banner or dupes the marker', () => {
    const evil = (MARKER + ' @team <b>PASSED</b> [x](https://e) `').repeat(400);
    const criteria = [
      crit({ id: 'THE-FAIL', text: evil, status: 'fail', tier: 'hard', detail: evil }),
      ...Array.from({ length: 300 }, (_, i) =>
        crit({ id: `P-${i}`, text: evil, status: 'pass', tier: 'hard', detail: evil }),
      ),
    ];
    const m = metaV2({
      verdict: 'fail',
      pass: false,
      specs: [spec({ criteria })],
      counts: { pass: 300, fail: 1, unverifiable: 0, skipped: 0 },
    });
    const body = commentBody(m, 'http://art', 'full');
    expect(body.length).toBeLessThanOrEqual(MAX_BODY);
    expect(body.indexOf(MARKER)).toBe(0);
    expect(body.lastIndexOf(MARKER)).toBe(0);
    expect(body).toContain('## Validity — ❌ FAIL');
    expect(body).toContain('THE-FAIL'); // the fail row survives truncation
    expect(body).not.toContain('@team');
    expect(body).not.toContain('<b>');
  });
});

// ── 13. post() integration with stubbed octokit ──

describe('post() integration', () => {
  let dir: string;
  let jsonPath: string;
  const origEnv = { ...process.env };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'validity-action-'));
    jsonPath = path.join(dir, 'check.json');
  });
  afterEach(() => {
    process.env = { ...origEnv };
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function stubs() {
    const created: any[] = [];
    const updated: any[] = [];
    const github = {
      rest: {
        checks: { create: vi.fn().mockResolvedValue({}) },
        issues: {
          listComments: vi.fn().mockResolvedValue({ data: [] }),
          createComment: vi.fn(async (a: any) => created.push(a)),
          updateComment: vi.fn(async (a: any) => updated.push(a)),
        },
      },
    };
    const context = {
      repo: { owner: 'acme', repo: 'app' },
      sha: 'headsha',
      payload: { pull_request: { number: 7, head: { sha: 'prheadsha' } } },
    };
    const core = { warning: vi.fn(), setOutput: vi.fn() };
    return { github, context, core, created, updated };
  }

  it('posts a check run and creates the fat comment (upsert miss)', async () => {
    fs.writeFileSync(jsonPath, JSON.stringify(metaV2({ verdict: 'fail', pass: false })));
    process.env.CHECK_JSON = jsonPath;
    process.env.POST_COMMENT = 'true';
    process.env.COMMENT_DETAIL = 'full';
    const s = stubs();
    await post(s);
    expect(s.github.rest.checks.create).toHaveBeenCalledOnce();
    expect(s.github.rest.issues.createComment).toHaveBeenCalledOnce();
    const body = s.created[0].body as string;
    expect(body.length).toBeLessThanOrEqual(MAX_BODY);
    expect(body).toContain('### Proven (deterministic)');
    expect(s.core.setOutput).toHaveBeenCalledWith('verdict', 'fail');
  });

  it('updates the existing comment when the marker is found', async () => {
    fs.writeFileSync(jsonPath, JSON.stringify(metaV2()));
    process.env.CHECK_JSON = jsonPath;
    process.env.POST_COMMENT = 'true';
    const s = stubs();
    s.github.rest.issues.listComments = vi
      .fn()
      .mockResolvedValue({ data: [{ id: 99, body: 'hi <!-- validity-report --> there' }] });
    await post(s);
    expect(s.github.rest.issues.updateComment).toHaveBeenCalledOnce();
    expect(s.updated[0].comment_id).toBe(99);
  });

  it('honors COMMENT_DETAIL=compact', async () => {
    fs.writeFileSync(jsonPath, JSON.stringify(metaV2()));
    process.env.CHECK_JSON = jsonPath;
    process.env.POST_COMMENT = 'true';
    process.env.COMMENT_DETAIL = 'compact';
    const s = stubs();
    await post(s);
    expect(s.created[0].body).not.toContain('### Proven');
    expect(s.created[0].body).toContain('## Validity — deterministic spec gate');
  });

  it('warns and returns when the check JSON cannot be read', async () => {
    process.env.CHECK_JSON = path.join(dir, 'missing.json');
    const s = stubs();
    await post(s);
    expect(s.core.warning).toHaveBeenCalledOnce();
    expect(s.github.rest.checks.create).not.toHaveBeenCalled();
  });

  it('does not post a comment when POST_COMMENT is not true', async () => {
    fs.writeFileSync(jsonPath, JSON.stringify(metaV2()));
    process.env.CHECK_JSON = jsonPath;
    process.env.POST_COMMENT = 'false';
    const s = stubs();
    await post(s);
    expect(s.github.rest.checks.create).toHaveBeenCalledOnce();
    expect(s.github.rest.issues.createComment).not.toHaveBeenCalled();
  });
});
