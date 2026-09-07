/**
 * Tests for the signed-summary PR comment.
 *
 * Three things matter here:
 *   1. the two lanes are never blended (the product's central claim);
 *   2. self-scored work is called out loudly, not footnoted;
 *   3. nothing attacker-authored can go active in a comment posted with the
 *      workflow's own token.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const mod = require_('./summary-comment.cjs') as {
  summaryCommentBody: (input: unknown, artifactUrl?: string) => string;
  compactSummaryBody: (input: unknown, artifactUrl?: string) => string;
  laneCounts: (summary: unknown) => Record<string, number | boolean>;
  laneLines: (summary: unknown) => string[];
  selfScoredCallout: (summary: unknown) => string[] | null;
  criteriaSection: (summary: unknown) => string[];
  provenanceSection: (input: unknown) => string[];
  artifactSection: (input: unknown, artifactUrl?: string) => string[];
  escapeCell: (s: unknown) => string;
  safeUrl: (s: unknown) => string;
  MARKER: string;
  MAX_BODY: number;
};

const {
  summaryCommentBody,
  laneCounts,
  laneLines,
  selfScoredCallout,
  criteriaSection,
  provenanceSection,
  artifactSection,
  escapeCell,
  safeUrl,
  MARKER,
  MAX_BODY,
} = mod;

// ---------------------------------------------------------------------------
// Fixtures — signed run summaries
// ---------------------------------------------------------------------------

function fixture(overrides: Record<string, unknown> = {}) {
  return {
    summary: {
      summaryVersion: 1,
      runId: 'run-2026-07-30-0001',
      specId: 'spec-login-form',
      specVersion: 3,
      specHash: 'sha256-9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0',
      scoringContractVersion: 'v1',
      commitSha: '1234567890abcdef1234567890abcdef12345678',
      branch: 'feat/login',
      dirty: false,
      createdAt: '2026-07-30T10:00:00.000Z',
      publishedAt: '2026-07-30T11:00:00.000Z',
      mode: 'isolation',
      verdict: 'partial',
      signedOff: false,
      scoring: { judge: 'self', selfScored: true },
      criteria: [
        { id: 'AC-1', tier: 'hard', verdict: 'pass', taints: [] },
        { id: 'AC-2', tier: 'hard', verdict: 'fail', taints: ['network'] },
        { id: 'AC-3', tier: 'property', verdict: 'unverifiable', taints: ['wrapper'] },
        { id: 'AC-4', tier: 'soft', verdict: 'pass', taints: [], selfScored: true },
        { id: 'AC-5', tier: 'soft', verdict: 'fail', taints: [], selfScored: true },
      ],
      screenshotHashes: ['a'.repeat(64), 'b'.repeat(64)],
      screenshotCount: 3,
      reportHash: 'c'.repeat(64),
      attestation: { digest: `sha256-${'d'.repeat(64)}`, signature: 'c2ln' },
      ...overrides,
    },
    digest: `sha256-${'e'.repeat(64)}`,
    signature: 'c2lnbmF0dXJl',
    publicKey: 'MCowBQYDK2VwAyEAabcdefghijklmnopqrstuvwxyz0123456789ABCD=',
  };
}

const freshJudged = () =>
  fixture({
    scoring: { judge: 'fresh-context', selfScored: false },
    criteria: [
      { id: 'AC-1', tier: 'hard', verdict: 'pass', taints: [] },
      {
        id: 'AC-4',
        tier: 'soft',
        verdict: 'pass',
        taints: [],
        scoredBy: 'anthropic/claude-opus-5',
      },
    ],
  });

// ---------------------------------------------------------------------------

describe('laneCounts — the two lanes are never blended', () => {
  it('separates hard/property from soft', () => {
    expect(laneCounts(fixture().summary)).toEqual({
      provenTotal: 3,
      provenPassed: 1,
      provenFailed: 1,
      provenUnverifiable: 1,
      judgedTotal: 2,
      judgedPassed: 1,
      selfScored: true,
    });
  });

  it('never produces one combined pass count', () => {
    const line = laneLines(fixture().summary)[0]!;
    expect(line).toContain('Machine-verified 1/3');
    expect(line).toContain('Judged 1/2');
    // 2/5 would be the blended number — it must not appear anywhere.
    expect(line).not.toContain('2/5');
  });

  it('marks a fresh-context judged lane distinctly from a self-scored one', () => {
    expect(laneLines(freshJudged().summary)[0]).toContain('(fresh-context)');
    expect(laneLines(fixture().summary)[0]).toContain('(self-scored)');
  });

  it('renders an em dash when there is no judged lane at all', () => {
    const s = fixture({ criteria: [{ id: 'A', tier: 'hard', verdict: 'pass', taints: [] }] });
    expect(laneLines(s.summary)[0]).toContain('Judged 0/0');
  });
});

describe('self-scored callout', () => {
  it('fires loudly when soft criteria were self-scored', () => {
    const callout = selfScoredCallout(fixture().summary)!;
    expect(callout.join('\n')).toContain('SELF-SCORED');
    expect(callout.join('\n')).toContain('the same agent that did the work');
  });

  it('does not fire for a fresh-context judge', () => {
    expect(selfScoredCallout(freshJudged().summary)).toBeNull();
  });

  it('does not fire when there are no judged criteria', () => {
    const s = fixture({
      criteria: [{ id: 'A', tier: 'hard', verdict: 'pass', taints: [] }],
      scoring: { judge: 'self', selfScored: true },
    });
    expect(selfScoredCallout(s.summary)).toBeNull();
  });

  it('is present in the full body', () => {
    expect(summaryCommentBody(fixture())).toContain('SELF-SCORED');
  });
});

describe('criteria table', () => {
  it('orders fails first, then unverifiable, then passes — id as the tiebreak', () => {
    const ids = criteriaSection(fixture().summary)
      .filter((l) => l.startsWith('| `'))
      .map((l) => l.slice(3, l.indexOf('`', 3)));
    // AC-2 + AC-5 fail, AC-3 is unverifiable, AC-1 + AC-4 pass.
    expect(ids).toEqual(['AC-2', 'AC-5', 'AC-3', 'AC-1', 'AC-4']);
  });

  it('labels the scorer per tier', () => {
    const section = criteriaSection(fixture().summary).join('\n');
    expect(section).toContain('mechanical');
    expect(section).toContain('self-scored');
  });

  it('renders taints with their labels', () => {
    expect(criteriaSection(fixture().summary).join('\n')).toContain('⛓ network');
  });

  it('handles an empty criteria list', () => {
    expect(criteriaSection({ criteria: [] }).join('\n')).toContain('no criterion verdicts');
  });

  it('carries no criterion text column — the contract never sends prose', () => {
    const header = criteriaSection(fixture().summary)[1]!;
    expect(header).toBe('| Criterion | Tier | Result | Evidence | Scored by |');
  });
});

describe('provenance', () => {
  it('names spec, commit, digests and the signing key', () => {
    const section = provenanceSection(fixture()).join('\n');
    expect(section).toContain('spec-login-form@v3');
    expect(section).toContain('1234567'); // short commit
    expect(section).toContain('feat/login');
    expect(section).toContain('Summary digest');
    expect(section).toContain('Run attestation');
    expect(section).toContain('Signing key');
  });

  it('says plainly that the key proves integrity, not identity', () => {
    expect(provenanceSection(fixture()).join('\n')).toContain('not who ran it');
  });

  it('flags a dirty working tree', () => {
    expect(provenanceSection(fixture({ dirty: true })).join('\n')).toContain('dirty');
  });

  it('omits rows whose data is absent', () => {
    const bare = {
      summary: {
        runId: 'r',
        criteria: [],
        screenshotHashes: [],
        screenshotCount: 0,
        attestation: { digest: 'sha256-x', signature: 's' },
      },
    };
    const section = provenanceSection(bare).join('\n');
    expect(section).not.toContain('Commit');
    expect(section).not.toContain('Spec:');
  });
});

describe('artifact linkage', () => {
  it('links the CI artifact and prints the reportHash to check it against', () => {
    const section = artifactSection(
      fixture(),
      'https://github.com/acme/app/actions/runs/1/artifacts/2',
    ).join('\n');
    expect(section).toContain('https://github.com/acme/app/actions/runs/1/artifacts/2');
    expect(section).toContain('shasum -a 256 report.html');
    expect(section).toContain('c'.repeat(64));
  });

  it('says the report stays in local storage when no URL is given', () => {
    expect(artifactSection(fixture()).join('\n')).toContain('never leaves your storage');
  });

  it('falls back to the summary reportUrl', () => {
    const s = fixture({ reportUrl: 'https://example.test/report' });
    expect(artifactSection(s).join('\n')).toContain('https://example.test/report');
  });
});

describe('security — nothing attacker-authored goes active', () => {
  it.each([
    ['javascript:', 'javascript:alert(1)'],
    ['http (not https)', 'http://evil.test/x'],
    ['a url with a paren', 'https://evil.test/x)[click](javascript:alert(1)'],
    ['empty', ''],
  ])('refuses to render %s as a link', (_label, url) => {
    expect(safeUrl(url)).toBe('');
  });

  it.each([
    ['javascript:', 'javascript:alert(1)'],
    ['http (not https)', 'http://evil.test/x'],
    ['a url with a paren', 'https://evil.test/x)[click](javascript:alert(1)'],
  ])('keeps %s out of the rendered section entirely', (_label, url) => {
    const section = artifactSection(
      { summary: { criteria: [], screenshotHashes: [], screenshotCount: 0 } },
      url,
    ).join('\n');
    expect(section).not.toContain(url);
    expect(section).toContain('never leaves your storage');
  });

  it('escapes HTML, backticks and brackets in a criterion id', () => {
    expect(escapeCell('<img src=x onerror=alert(1)>')).not.toContain('<img');
    expect(escapeCell('`code`')).toContain('&#96;');
    expect(escapeCell('[link](http://x)')).toContain('&#91;');
  });

  it('defuses @-mentions', () => {
    expect(escapeCell('@everyone')).toContain('@​');
  });

  it('cannot be made to forge the upsert marker via a criterion id', () => {
    const s = fixture({
      criteria: [{ id: `${MARKER} spoof`, tier: 'hard', verdict: 'pass', taints: [] }],
    });
    const body = summaryCommentBody(s);
    // Exactly one marker — the real one at the top.
    expect(body.split(MARKER).length - 1).toBe(1);
  });

  it('escapes an unknown taint value rather than trusting it', () => {
    const s = fixture({
      criteria: [{ id: 'A', tier: 'hard', verdict: 'pass', taints: ['<script>'] }],
    });
    expect(criteriaSection(s.summary).join('\n')).not.toContain('<script>');
  });
});

describe('body assembly', () => {
  it('is deterministic — same input, byte-identical output', () => {
    expect(summaryCommentBody(fixture())).toBe(summaryCommentBody(fixture()));
  });

  it('starts with the marker and a verdict header', () => {
    const body = summaryCommentBody(fixture());
    expect(body.startsWith(MARKER)).toBe(true);
    expect(body).toContain('## Validity — ⚠️ PARTIAL');
  });

  it('uses a marker distinct from post-check.cjs so both comments coexist', () => {
    expect(MARKER).toBe('<!-- validity-run-summary -->');
    expect(MARKER).not.toBe('<!-- validity-report -->');
  });

  it('advertises the zero-token re-verification', () => {
    expect(summaryCommentBody(fixture())).toContain('0 LLM tokens');
  });

  it('accepts a bare summary as well as a signed envelope', () => {
    const body = summaryCommentBody(fixture().summary);
    expect(body).toContain('## Validity');
    expect(body).not.toContain('Summary digest'); // no envelope ⇒ no envelope rows
  });

  it('falls back to the compact body when the full one would exceed the limit', () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({
      id: `AC-${i}-${'x'.repeat(120)}`,
      tier: 'hard',
      verdict: 'fail',
      taints: ['network'],
    }));
    const body = summaryCommentBody(fixture({ criteria: many }));
    expect(body.length).toBeLessThanOrEqual(MAX_BODY);
  });

  it('stays under the limit for a large but plausible run', () => {
    const many = Array.from({ length: 300 }, (_, i) => ({
      id: `AC-${i}`,
      tier: i % 3 === 0 ? 'soft' : 'hard',
      verdict: 'pass',
      taints: [],
    }));
    expect(summaryCommentBody(fixture({ criteria: many })).length).toBeLessThanOrEqual(MAX_BODY);
  });

  it('does not throw on a malformed summary', () => {
    expect(() => summaryCommentBody({})).not.toThrow();
    expect(() => summaryCommentBody({ summary: {} })).not.toThrow();
    expect(() => summaryCommentBody(null)).not.toThrow();
  });
});
