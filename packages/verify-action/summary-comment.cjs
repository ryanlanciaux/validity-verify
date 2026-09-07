/**
 * The GitHub PR comment: rendered from the SIGNED RUN SUMMARY.
 *
 * This is a sibling of `post-check.cjs`, not a replacement, and the difference
 * is the input:
 *
 *   - `post-check.cjs` renders from `validity-check.json`, which is local
 *     verify output. It has criterion TEXT, detail strings, and coverage — rich,
 *     but unsigned and local-only.
 *   - this module renders from the signed run summary. Less prose, but every
 *     number in it is covered by an Ed25519 signature a reviewer can check.
 *
 * So this comment leads with PROVENANCE. Its job is not to re-explain the run;
 * it is to let a reviewer answer "can I trust this green?" in ten seconds:
 *
 *   1. the two lanes, never blended — machine-verified vs judged;
 *   2. a self-scored warning when the agent graded its own work;
 *   3. the criterion table, ids only (the summary carries no text by contract);
 *   4. provenance: commit, spec hash, signing key, run digest;
 *   5. the artifact link AND its reportHash, so "the report I downloaded is
 *      the report this summary describes" is checkable, not assumed.
 *
 * Pure, dependency-free CommonJS like its sibling, so `actions/github-script`
 * can `require()` it with no build step and the builders are unit-testable.
 *
 * SECURITY NOTE: every value here is attacker-influenceable (a spec id lives in
 * a committed spec.yaml). The escaping helpers are copied in shape from
 * `post-check.cjs` — HTML entities, backticks and `[` neutralized, @-mentions
 * defused — because a comment posted with the workflow's own token must not be
 * able to go active.
 */

const MAX_BODY = 65536; // GitHub's hard limit on a comment body
const CRITERIA_CAP = 40000; // row budget for the criterion table

const MARKER = '<!-- validity-run-summary -->';

const VERDICT_HEADER = {
  pass: '✅ PASS',
  fail: '❌ FAIL',
  partial: '⚠️ PARTIAL',
  unverifiable: '⚠️ UNVERIFIABLE',
};

const STATUS_BADGE = {
  pass: '✅ pass',
  fail: '❌ fail',
  unverifiable: '⚠️ unverifiable',
};

const TAINT_LABELS = {
  network: '⛓ network',
  wrapper: '🎁 wrapper',
  'synthetic-data': '🧬 synthetic-data',
  'unconfirmed-render': '❓ unconfirmed-render',
  'dep-scan': '🔍 dep-scan',
  'data-state': '◐ data-state',
};

const TIER_LABELS = { hard: 'hard', property: 'property', soft: 'soft' };

// ── Escaping (mirrors post-check.cjs) ──────────────────────────────────────

function escapeCell(s) {
  return String(s == null ? '' : s)
    .replace(/\r?\n/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;')
    .replace(/\[/g, '&#91;')
    .replace(/@/g, '@​')
    .replace(/\|/g, '\\|')
    .trim();
}

/**
 * Wrap a value in a markdown code span. Code-span content renders inert on
 * GitHub, so no entity escaping — ids display verbatim.
 *
 * EXCEPT for HTML-comment delimiters. The upsert logic finds "our" comment by a
 * raw `body.includes(MARKER)` substring search, so a criterion id containing
 * the marker text would forge it even though markdown renders it literally
 * inside backticks. A zero-width space breaks the substring without changing
 * how the id reads — the same trick used on `@` for mentions.
 */
function codeSpan(s) {
  const inner = String(s == null ? '' : s)
    .replace(/\r?\n/g, ' ')
    .replace(/`/g, "'")
    .replace(/<!--/g, '<!​--')
    .replace(/-->/g, '--​>')
    .replace(/\|/g, '\\|')
    .trim();
  return '`' + (inner || ' ') + '`';
}

function clip(s, n) {
  const str = String(s == null ? '' : s);
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

/** Only ever render a URL we are confident is a plain https link. */
function safeUrl(url) {
  const s = String(url == null ? '' : url).trim();
  if (!/^https:\/\/[^\s<>"')]+$/.test(s)) return '';
  return s;
}

function short(s, n) {
  const str = String(s == null ? '' : s);
  return str.length <= n ? str : str.slice(0, n);
}

function capRows(rows, cap, noun) {
  const kept = [];
  let len = 0;
  for (let i = 0; i < rows.length; i++) {
    const omitted = rows.length - i;
    const overflow = `_…and ${omitted} more ${noun} — see the report artifact._`;
    if (len + rows[i].length + 1 + overflow.length + 1 > cap) {
      kept.push(overflow);
      return kept;
    }
    kept.push(rows[i]);
    len += rows[i].length + 1;
  }
  return kept;
}

// ── Pure derivations ───────────────────────────────────────────────────────

/**
 * Two-lane counts. MUST agree with `laneCounts` in
 * `convex/runSummaryContract.ts` — the comment and the stored scorecard row are
 * two renderings of one fact, and disagreeing would be its own kind of false
 * green.
 */
function laneCounts(summary) {
  const counts = {
    provenTotal: 0,
    provenPassed: 0,
    provenFailed: 0,
    provenUnverifiable: 0,
    judgedTotal: 0,
    judgedPassed: 0,
    selfScored: false,
  };
  const criteria = Array.isArray(summary.criteria) ? summary.criteria : [];
  for (const c of criteria) {
    if (c.tier === 'soft') {
      counts.judgedTotal++;
      if (c.verdict === 'pass') counts.judgedPassed++;
      if (c.selfScored === true) counts.selfScored = true;
    } else {
      counts.provenTotal++;
      if (c.verdict === 'pass') counts.provenPassed++;
      else if (c.verdict === 'fail') counts.provenFailed++;
      else counts.provenUnverifiable++;
    }
  }
  if (summary.scoring && summary.scoring.selfScored === true) counts.selfScored = true;
  return counts;
}

/** Accept either the signed envelope or a bare summary. */
function unwrap(input) {
  if (input && typeof input === 'object' && input.summary && typeof input.summary === 'object') {
    return { summary: input.summary, envelope: input };
  }
  return { summary: input || {}, envelope: {} };
}

// ── Sections ───────────────────────────────────────────────────────────────

/**
 * The headline: two adjacent rollups that are never added together. A
 * machine-verified pass and a model-judged pass are different kinds of fact,
 * and one blended "12/14" would be exactly the false green Validity exists to
 * prevent (plan Part 1.3).
 */
function laneLines(summary) {
  const c = laneCounts(summary);
  const lines = [];
  lines.push(
    `**Machine-verified ${c.provenPassed}/${c.provenTotal}** ● ` +
      `**Judged ${c.judgedPassed}/${c.judgedTotal}** ` +
      (c.judgedTotal === 0 ? '—' : c.selfScored ? '⚠️ (self-scored)' : '(fresh-context)'),
  );
  const parts = [];
  if (c.provenFailed > 0) parts.push(`${c.provenFailed} failed`);
  if (c.provenUnverifiable > 0) parts.push(`${c.provenUnverifiable} unverifiable`);
  if (parts.length) lines.push(`Deterministic lane: ${parts.join(' · ')}.`);
  return lines;
}

/**
 * The self-scored callout — the single most important honesty signal in the
 * whole comment. When the agent that did the work also graded it, say so
 * loudly; a quiet footnote is how "the agent grades its own work" becomes a
 * fair criticism.
 */
function selfScoredCallout(summary) {
  const c = laneCounts(summary);
  if (!c.selfScored || c.judgedTotal === 0) return null;
  return [
    `> ⚠️ **${c.judgedPassed}/${c.judgedTotal} judged criteria were SELF-SCORED** — graded by the same agent that did the work.`,
    '> The machine-verified lane above is unaffected: those verdicts are mechanical and cannot be overridden by a scorer.',
  ];
}

function criteriaSection(summary) {
  const criteria = Array.isArray(summary.criteria) ? summary.criteria.slice() : [];
  if (criteria.length === 0) {
    return ['### Criteria', '_The signed summary carries no criterion verdicts._'];
  }
  // Fails first, then unverifiable, then passes; deterministic tiebreak by id.
  const RANK = { fail: 0, unverifiable: 1, pass: 2 };
  criteria.sort((a, b) => {
    const ra = RANK[a.verdict] == null ? 9 : RANK[a.verdict];
    const rb = RANK[b.verdict] == null ? 9 : RANK[b.verdict];
    if (ra !== rb) return ra - rb;
    return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
  });

  const rows = criteria.map((c) => {
    const taints =
      Array.isArray(c.taints) && c.taints.length
        ? c.taints.map((t) => TAINT_LABELS[t] || escapeCell(t)).join(', ')
        : '—';
    const scorer =
      c.tier === 'soft'
        ? c.selfScored === true
          ? '⚠️ self-scored'
          : c.scoredBy
            ? escapeCell(clip(c.scoredBy, 40))
            : 'fresh-context'
        : 'mechanical';
    return (
      '| ' +
      [
        codeSpan(c.id),
        escapeCell(TIER_LABELS[c.tier] || c.tier),
        STATUS_BADGE[c.verdict] || escapeCell(c.verdict),
        taints,
        scorer,
      ].join(' | ') +
      ' |'
    );
  });

  return [
    '### Criteria',
    '| Criterion | Tier | Result | Evidence | Scored by |',
    '| --- | --- | --- | --- | --- |',
  ].concat(capRows(rows, CRITERIA_CAP, 'criteria'));
}

/**
 * Provenance — what makes this comment different from a screenshot loop's
 * output. Everything here is checkable against the run dir with
 * `validity attest verify`.
 */
function provenanceSection(input) {
  const { summary, envelope } = unwrap(input);
  const lines = ['### Provenance'];
  const rows = [];

  if (summary.specId) {
    rows.push(
      `- **Spec:** ${codeSpan(summary.specId + (summary.specVersion != null ? `@v${summary.specVersion}` : ''))}` +
        (summary.specHash ? ` · hash ${codeSpan(short(summary.specHash, 23))}` : ''),
    );
  }
  if (summary.commitSha) {
    rows.push(
      `- **Commit:** ${codeSpan(short(summary.commitSha, 7))}` +
        (summary.branch ? ` on ${codeSpan(summary.branch)}` : '') +
        (summary.dirty === true ? ' ⚠️ _working tree was dirty at capture time_' : ''),
    );
  }
  if (summary.mode) rows.push(`- **Mode:** ${codeSpan(summary.mode)}`);
  rows.push(
    `- **Evidence:** ${Array.isArray(summary.screenshotHashes) ? summary.screenshotHashes.length : 0}` +
      ` screenshot hash(es) of ${Number(summary.screenshotCount) || 0} render(s)`,
  );
  if (envelope.digest) rows.push(`- **Summary digest:** ${codeSpan(short(envelope.digest, 23))}…`);
  if (summary.attestation && summary.attestation.digest) {
    rows.push(`- **Run attestation:** ${codeSpan(short(summary.attestation.digest, 23))}…`);
  }
  if (envelope.publicKey) {
    rows.push(
      `- **Signing key:** ${codeSpan(short(envelope.publicKey, 16))}… _(per-machine key — proves the record is unmodified, not who ran it)_`,
    );
  }
  if (summary.scoringContractVersion) {
    rows.push(`- **Scoring contract:** ${codeSpan(summary.scoringContractVersion)}`);
  }
  return lines.concat(rows);
}

/**
 * The artifact linkage. `reportHash` is the whole point: it lets a reviewer
 * confirm the report they downloaded is the one this signed summary describes,
 * rather than trusting that the link goes somewhere honest.
 */
function artifactSection(input, artifactUrl) {
  const { summary } = unwrap(input);
  const url = safeUrl(artifactUrl || summary.reportUrl);
  const lines = ['### Full report'];
  if (url) {
    lines.push(
      `📎 [Download report.html](${url}) — in **your** repo's GitHub artifacts.`,
    );
  } else {
    lines.push('_report.html was uploaded as a build artifact (it never leaves your storage)._');
  }
  if (summary.reportHash) {
    lines.push(
      '',
      `Verify the download is the report this summary describes:`,
      '```bash',
      `shasum -a 256 report.html`,
      `# expected: ${short(String(summary.reportHash).replace(/[^0-9a-f]/g, ''), 64)}`,
      '```',
    );
  }
  return lines;
}

function footerLines() {
  return [
    '---',
    '🔏 Every number above is covered by an Ed25519 signature checked at ingest — ' +
      'run `validity attest verify <run-dir>` to re-derive it locally. ' +
      'Re-verified deterministically: **0 LLM tokens**.',
    '> Judged (soft) criteria are advisory and never block. Machine-verified verdicts are mechanical and cannot be overridden by a scorer.',
  ];
}

// ── Assembly ───────────────────────────────────────────────────────────────

/**
 * Render the whole comment from a signed summary.
 *
 * `input` may be the signed envelope (`{ summary, digest, signature, publicKey }`)
 * or a bare summary; the provenance section simply renders less in the latter
 * case. Deterministic: same input ⇒ byte-identical output.
 */
function summaryCommentBody(input, artifactUrl) {
  const { summary } = unwrap(input);
  const verdict = summary.verdict || 'partial';
  const lines = [MARKER, `## Validity — ${VERDICT_HEADER[verdict] || escapeCell(verdict)}`, ''];

  const callout = selfScoredCallout(summary);
  if (callout) lines.push(...callout, '');

  lines.push(...laneLines(summary), '');
  lines.push(...criteriaSection(summary), '');
  lines.push(...provenanceSection(input), '');
  lines.push(...artifactSection(input, artifactUrl), '');
  lines.push(...footerLines());

  const body = lines.join('\n');
  return body.length > MAX_BODY ? compactSummaryBody(input, artifactUrl) : body;
}

/** Last-resort body that always fits: verdict, lanes, provenance, link. */
function compactSummaryBody(input, artifactUrl) {
  const { summary } = unwrap(input);
  const verdict = summary.verdict || 'partial';
  const url = safeUrl(artifactUrl || summary.reportUrl);
  return [
    MARKER,
    `## Validity — ${VERDICT_HEADER[verdict] || escapeCell(verdict)}`,
    '',
    ...laneLines(summary),
    '',
    url
      ? `📎 [Download report.html](${url}) (your GitHub artifacts).`
      : '_report.html was uploaded as a build artifact._',
    '',
    ...footerLines(),
  ].join('\n');
}

/**
 * Upsert the comment on a PR, keyed by the hidden marker so re-runs update in
 * place. Uses a marker DISTINCT from `post-check.cjs`'s so both comments can
 * coexist without clobbering each other.
 */
async function postSummaryComment({ github, context, core }, signed, artifactUrl) {
  const prNumber = context.payload.pull_request && context.payload.pull_request.number;
  if (!prNumber) return;
  const body = summaryCommentBody(signed, artifactUrl);
  try {
    const { data: comments } = await github.rest.issues.listComments({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: prNumber,
    });
    const existing = comments.find((c) => c.body && c.body.includes(MARKER));
    if (existing) {
      await github.rest.issues.updateComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        comment_id: existing.id,
        body,
      });
    } else {
      await github.rest.issues.createComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: prNumber,
        body,
      });
    }
  } catch (err) {
    core.warning(`Validity: could not upsert the run-summary comment: ${err.message}`);
  }
}

/** Entry point for `actions/github-script`. */
module.exports = async function post({ github, context, core }) {
  const fs = require('fs');
  const path = process.env.SUMMARY_JSON;
  let signed;
  try {
    signed = JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (err) {
    core.warning(`Validity: could not read the signed summary at ${path}: ${err.message}`);
    return;
  }
  await postSummaryComment({ github, context, core }, signed, process.env.ARTIFACT_URL || '');
};

// Pure builders, exported for unit tests.
module.exports.summaryCommentBody = summaryCommentBody;
module.exports.compactSummaryBody = compactSummaryBody;
module.exports.postSummaryComment = postSummaryComment;
module.exports.laneCounts = laneCounts;
module.exports.laneLines = laneLines;
module.exports.selfScoredCallout = selfScoredCallout;
module.exports.criteriaSection = criteriaSection;
module.exports.provenanceSection = provenanceSection;
module.exports.artifactSection = artifactSection;
module.exports.escapeCell = escapeCell;
module.exports.safeUrl = safeUrl;
module.exports.MARKER = MARKER;
module.exports.MAX_BODY = MAX_BODY;
