/**
 * Post a check run + (optionally) a PR comment from a `verify --all`
 * `--check-output` JSON. Plain CommonJS so `actions/github-script` can
 * `require()` it. Metadata only — this never reads the report.html bytes.
 *
 * The check CONCLUSION is 3-way so a partial run is never shown as a clean
 * green, yet soft criteria never BLOCK:
 *   - build gate failed (hard fail / coverage-floor breach) → `failure`
 *   - clean pass                                            → `success`
 *   - partial (soft or unverifiable, build still green)     → `neutral`
 * `neutral` does not fail branch protection, so soft criteria stay advisory.
 *
 * The PR comment upgrades from counts-only to a per-criterion verdict surface
 * (Proven vs Scored tables, a "Not validated" section, badges, Validity Score,
 * regression-vs-base) whenever the CLI writes CheckMetadata v2 (`meta.specs`).
 * v1 metadata (no `specs`) still renders the original compact body, byte for
 * byte — the fat path is purely additive and every section renders only when
 * its data is present. This module remains dependency-free CommonJS: pure
 * builders are exported (`module.exports.commentBody` etc.) for unit tests, and
 * the action still `require()`s the `.cjs` directly with no build step.
 */
const fs = require('fs');

// ── Truncation budget (GitHub caps a comment body at 65,536 chars) ──
const MAX_BODY = 65536; // GitHub hard limit
const SAFE_BUDGET = 60000; // assembly target, margin for marker/footer growth
// Per-section row-budget caps. Σ CAPS (54,000) + the structurally-bounded fixed
// parts (< ~2,000 given cell clipping) stays under SAFE_BUDGET, so the fat body
// cannot exceed MAX_BODY; the `commentBody` guard is a belt-and-braces fallback.
const CAPS = { proven: 30000, scored: 8000, notValidated: 10000, base: 6000 };
// Per-cell character clips — keep any single row structurally bounded.
const CLIP = { text: 100, detail: 160, error: 160 };

// Presentation vocabulary — mirror the CLI step-summary emoji (verify-all.ts).
const STATUS_BADGE = {
  pass: '✅ pass',
  fail: '❌ fail',
  unverifiable: '⚠️ unverifiable',
  skipped: '⏭️ not scored in CI',
};
const TAINT_LABELS = {
  network: '⛓ network',
  wrapper: '🎁 wrapper',
  'synthetic-data': '🧬 synthetic-data',
  'unconfirmed-render': '❓ unconfirmed-render',
};
// Reason label for the "Not validated" grouping (taint key ⇒ human phrase).
const TAINT_REASON = {
  network: 'network-tainted',
  wrapper: 'wrapper-degraded',
  'synthetic-data': 'synthetic-data',
  'unconfirmed-render': 'unconfirmed-render',
};
const JUDGE_LABELS = {
  self: '⚠️ self-scored',
  'fresh-context': 'fresh-context',
  human: 'human',
};
const VERDICT_HEADER = {
  pass: '✅ PASS',
  fail: '❌ FAIL',
  partial: '⚠️ PARTIAL',
};
// Proven-table severity ordering: fails render before anything else, so a
// fail row is only ever dropped by truncation after every pass/unverifiable
// row is already gone (and the header count + FAIL banner still name it).
const SEVERITY_RANK = { fail: 0, unverifiable: 1, pass: 2, skipped: 3 };
// Substring the CLI writes when a hard criterion produced no mechanical verdict
// (verify-all.ts: 'no mechanical verdict produced for this criterion').
const NO_MECHANICAL_VERDICT = 'no mechanical verdict';

/** Map verdict + gate into a 3-way check-run conclusion. */
function conclusionFor(meta) {
  if (!meta.pass) return 'failure'; // hard fail or coverage-floor breach
  return meta.verdict === 'pass' ? 'success' : 'neutral'; // partial ⇒ neutral, never a clean green
}

function summaryLine(meta) {
  const c = meta.counts || {};
  const cov = meta.coveragePercent == null ? '' : ` · coverage ${meta.coveragePercent}%`;
  const eb = envBlockedCount(meta) > 0 ? ` · ${envBlockedCount(meta)} environment-blocked` : '';
  return (
    `${meta.verdict.toUpperCase()} — ` +
    `${c.pass || 0} pass · ${c.fail || 0} fail · ${c.unverifiable || 0} unverifiable · ` +
    `${c.skipped || 0} soft (advisory)${cov}${eb}`
  );
}

/**
 * Guarded count out of `meta.envBlocked` — absent on metadata from an older
 * CLI (the field is additive), so every reader goes through this rather than
 * touching `meta.envBlocked.count` directly.
 */
function envBlockedCount(meta) {
  const eb = meta.envBlocked;
  return eb && Number(eb.count) > 0 ? Number(eb.count) : 0;
}

/**
 * Check-run TITLE (b): names the environment-blocked count alongside the
 * verdict so it's visible in the Checks tab summary list without opening the
 * run, without changing the 3-way conclusion (still `failure` — this is
 * ATTRIBUTION, never a softer conclusion).
 */
function checkTitle(meta) {
  const base = `Validity — ${meta.verdict}`;
  const n = envBlockedCount(meta);
  return n > 0 ? `${base} (environment blocked — ${n} spec${n === 1 ? '' : 's'})` : base;
}

/**
 * Short "⚠ Environment blocked" callout (a): lists the N specs + the deduped
 * error reasons `verify-all`'s `computeEnvBlocked` produced. Guarded on
 * `meta.envBlocked` being present and non-empty — absent (older CLI) or empty
 * ⇒ null, so both `compactBody` and `fatBody` render byte-identical to today
 * when the field is missing.
 */
function envBlockedCallout(meta) {
  const eb = meta.envBlocked;
  const count = envBlockedCount(meta);
  if (count === 0) return null;
  const errors = Array.isArray(eb.errors) ? eb.errors : [];
  const lines = [
    `> ⚠ **Environment blocked — ${count} spec${count === 1 ? '' : 's'} produced no verdicts.**`,
    '> This gate failure may be environmental (a broken sandbox/device), not a code regression.',
  ];
  // Per-error attribution, keyed by the same deduped error string. Absent on
  // metadata from an older CLI, and absent whenever nothing could be
  // diagnosed — an empty map just means the rows render exactly as before.
  const causeByError = new Map();
  if (Array.isArray(eb.causes)) {
    for (const c of eb.causes) {
      if (c && typeof c.error === 'string' && typeof c.cause === 'string')
        causeByError.set(c.error, c);
    }
  }
  const shown = errors.slice(0, 5);
  for (const e of shown) {
    const c = causeByError.get(e);
    // Only the FIRST line of the fix: a PR comment is not where the four-line
    // reset recipe gets run, and the CLI/report carry the whole thing.
    const fix = c && typeof c.fixCommand === 'string' ? c.fixCommand.split('\n')[0].trim() : '';
    const attribution = c
      ? ` — cause: \`${escapeCell(c.cause)}\`${fix ? `, fix: \`${escapeCell(fix)}\`` : ''}`
      : '';
    lines.push(`> - ${clip(escapeCell(e), CLIP.error)}${attribution}`);
  }
  if (errors.length > shown.length) {
    lines.push(`> - …and ${errors.length - shown.length} more distinct error(s)`);
  }
  return lines;
}

// ── Pure cell/string helpers ──

/**
 * Table-cell escape: no newlines, pipes escaped, trimmed — PLUS output
 * encoding for GitHub-rendered markdown. Everything routed through here is
 * attacker-influenceable (criterion ids/text live in spec.yaml, statuses in
 * committed run history) and the comment is posted with the workflow's own
 * token, so anything that could go "active" is neutralized:
 *   - HTML is entity-escaped (& < > " ') so `<img …>` can't render and a
 *     planted `<!-- validity-report -->` can't spoof the upsert marker;
 *   - backticks / `[` become numeric entities — CommonMark treats entity
 *     references as literal text, so they can't open code spans, links, or
 *     images;
 *   - a zero-width space after `@` defuses @-mentions (no notification spam).
 */
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
    .replace(/@/g, '@\u200b')
    .replace(/\|/g, '\\|')
    .trim();
}

/**
 * Wrap a value in a markdown code span (for ids/labels). A backtick INSIDE
 * the value would close the span and let the tail go active — and backslash
 * escapes don't work inside code spans — so backticks are replaced outright.
 * Code-span content is otherwise inert on GitHub (no HTML, links, or
 * @-mentions render), so no entity escaping: ids display verbatim.
 */
function codeSpan(s) {
  const inner = String(s == null ? '' : s)
    .replace(/\r?\n/g, ' ')
    .replace(/`/g, "'")
    .replace(/\|/g, '\\|')
    .trim();
  return '`' + (inner || ' ') + '`';
}

/** Clip to n chars with a trailing ellipsis. Deterministic, no word-splitting. */
function clip(s, n) {
  const str = String(s == null ? '' : s);
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

/** `id — text` for a criterion, text escaped+clipped; just `id` when text absent. */
function criterionCell(row) {
  const id = escapeCell(row.id);
  const text = clip(escapeCell(row.text || ''), CLIP.text);
  return text ? `${id} — ${text}` : id;
}

/** Evidence column from a taint list (unknown taints escaped, never trusted). */
function evidenceCell(taints) {
  if (!Array.isArray(taints) || taints.length === 0) return '—';
  return taints.map((t) => TAINT_LABELS[t] || escapeCell(t)).join(', ');
}

function judgeCell(judge) {
  if (!judge) return '—';
  return JUDGE_LABELS[judge] || escapeCell(judge);
}

function specLabel(spec) {
  return `${spec.specId}@v${spec.version}`;
}

/**
 * Greedy, deterministic row cap. Appends rows until the next one would leave no
 * room for the overflow line, then emits `_…and N more <noun> — see the report
 * artifact._`. Truncation unit is a whole row (markdown tables never break
 * mid-row). Same input ⇒ byte-identical output.
 */
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

/** Flatten criteria across specs, keeping spec/row indices for stable ordering. */
function collectRows(specs, predicate) {
  const out = [];
  specs.forEach((spec, si) => {
    const label = specLabel(spec);
    (spec.criteria || []).forEach((c, ri) => {
      if (predicate(c)) out.push({ c, spec, label, si, ri });
    });
  });
  return out;
}

// ── Section builders (each returns an array of lines) ──

function badgesLine(meta) {
  const badges = [];
  if (meta.unplanned === true) {
    badges.push('`UNPLANNED — criteria extracted after the work`');
  }
  const t = worstTemporal(meta.specs || []);
  if (t) badges.push('`' + t + '`');
  if (meta.enforcement === 'strict') badges.push('`strict`');
  return badges.length ? badges.join(' ') : null;
}

/**
 * Worst temporal classification across specs, or null when none carry it.
 * Labels are the HTML report's pill vocabulary (report.ts: 'spec frozen before
 * work' / 'spec frozen mid-work' / 'spec timing unknown') so both surfaces
 * speak one language; an unrecognized value reads as timing unknown — it is
 * never promoted to the good case. Mixed known+unknown keeps the known label
 * and appends "(N specs unknown)".
 */
function worstTemporal(specs) {
  const values = specs.map((s) => s.temporal).filter(Boolean);
  if (values.length === 0) return null;
  const unknownCount = specs.filter((s) => {
    const t = s.temporal;
    return t && t !== 'frozen-before-work' && t !== 'frozen-mid-work';
  }).length;
  const unknownSuffix =
    unknownCount > 0
      ? ' (' + unknownCount + ' spec' + (unknownCount === 1 ? '' : 's') + ' unknown)'
      : '';
  if (values.includes('frozen-mid-work')) return 'spec frozen mid-work' + unknownSuffix;
  const hasBefore = values.includes('frozen-before-work');
  if (hasBefore && unknownCount > 0) return 'spec frozen before work' + unknownSuffix;
  if (hasBefore) return 'spec frozen before work';
  return 'spec timing unknown';
}

function scoreLine(meta) {
  const vs = meta.validityScore;
  if (!vs || vs.current == null) return null;
  if (typeof vs.base === 'number') {
    const delta = vs.current - vs.base;
    const arrow = delta < 0 ? `▼${Math.abs(delta)}` : delta > 0 ? `▲${delta}` : '▬0';
    return `**Validity Score: ${vs.current} (base ${vs.base} · ${arrow})**`;
  }
  return `**Validity Score: ${vs.current}**`;
}

/**
 * Frozen-spec census note (W6 #23). Fires only when specs are UNTRACKED —
 * frozen locally but their spec.yaml isn't committed, so a fresh CI checkout
 * never saw them and this run's score/coverage denominator omits them. Names
 * the gap so a green comment can't imply the whole contract was verified.
 * Numbers come from the CLI (`gitTracksPath`), not attacker bytes — but they're
 * plain integers, so a defensive `Number()` is enough. Returns null otherwise.
 */
function specCensusLine(meta) {
  const c = meta.specCensus;
  if (!c) return null;
  const untracked = Number(c.untracked) || 0;
  if (untracked < 1) return null;
  const total = Number(c.total) || 0;
  const tracked = Math.max(0, total - untracked);
  return (
    `> ⚠️ **${untracked} of ${total} frozen spec(s) are untracked** — their \`spec.yaml\` isn't ` +
    `committed, so CI verified only the ${tracked} committed one(s); the score/coverage above ` +
    `count those. \`git add\` + commit the spec(s) to bring them into the contract.`
  );
}

function provenSection(meta) {
  const specs = meta.specs || [];
  const showSpec = specs.length > 1;
  const rows = collectRows(specs, (c) => c.tier !== 'soft');
  rows.sort((a, b) => {
    const ra = SEVERITY_RANK[a.c.status] == null ? 9 : SEVERITY_RANK[a.c.status];
    const rb = SEVERITY_RANK[b.c.status] == null ? 9 : SEVERITY_RANK[b.c.status];
    if (ra !== rb) return ra - rb;
    if (a.si !== b.si) return a.si - b.si;
    return a.ri - b.ri;
  });

  const head = showSpec
    ? [
        '| Spec | Criterion | Tier | Result | Evidence | Detail |',
        '| --- | --- | --- | --- | --- | --- |',
      ]
    : ['| Criterion | Tier | Result | Evidence | Detail |', '| --- | --- | --- | --- | --- |'];

  const lines = ['### Proven (deterministic)'];
  if (rows.length === 0) {
    lines.push('_No hard or property criteria in the frozen specs._');
    return lines;
  }
  const rowLines = rows.map((item) => {
    const c = item.c;
    const cells = [];
    if (showSpec) cells.push(codeSpan(item.label));
    cells.push(criterionCell(c));
    cells.push(escapeCell(c.tier));
    cells.push(STATUS_BADGE[c.status] || escapeCell(c.status));
    cells.push(evidenceCell(c.taints));
    cells.push(clip(escapeCell(c.detail || ''), CLIP.detail));
    return '| ' + cells.join(' | ') + ' |';
  });
  return lines.concat(head, capRows(rowLines, CAPS.proven, 'proven rows'));
}

function scoredSection(meta) {
  const specs = meta.specs || [];
  const showSpec = specs.length > 1;
  const rows = collectRows(specs, (c) => c.tier === 'soft');
  if (rows.length === 0) return null;

  const head = showSpec
    ? ['| Spec | Criterion | Judge | Status |', '| --- | --- | --- | --- |']
    : ['| Criterion | Judge | Status |', '| --- | --- | --- |'];
  const rowLines = rows.map((item) => {
    const c = item.c;
    const cells = [];
    if (showSpec) cells.push(codeSpan(item.label));
    cells.push(criterionCell(c));
    cells.push(judgeCell(c.judge));
    cells.push(STATUS_BADGE[c.status] || escapeCell(c.status));
    return '| ' + cells.join(' | ') + ' |';
  });
  return ['### Scored (advisory — needs an agent verify)'].concat(
    head,
    capRows(rowLines, CAPS.scored, 'scored rows'),
  );
}

/** Group key for an unverifiable hard/property row (its taint reason). */
function reasonKey(c) {
  if (Array.isArray(c.taints) && c.taints.length > 0) return c.taints[0];
  if (c.detail && String(c.detail).includes(NO_MECHANICAL_VERDICT)) return NO_MECHANICAL_VERDICT;
  return 'unverifiable (other)';
}

function reasonLabel(key) {
  return TAINT_REASON[key] || escapeCell(key);
}

function notValidatedSection(meta) {
  const specs = meta.specs || [];
  const counts = meta.counts || {};
  const lines = ['### Not validated'];

  // Coverage lead line.
  if (meta.coveragePercent == null) {
    lines.push('**Coverage unmeasurable — no hard/property criteria in the frozen specs.**');
  } else {
    const verifiable = (counts.pass || 0) + (counts.fail || 0);
    const total = verifiable + (counts.unverifiable || 0);
    lines.push(
      `**Coverage ${meta.coveragePercent}% — ${verifiable}/${total} hard/property criteria verifiable.** The remainder:`,
    );
  }

  const bullets = [];

  // (a) hard/property unverifiable rows grouped by reason.
  const unverifiable = collectRows(specs, (c) => c.tier !== 'soft' && c.status === 'unverifiable');
  const groups = new Map();
  for (const item of unverifiable) {
    const key = reasonKey(item.c);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(codeSpan(`${item.spec.specId}/${item.c.id}`));
  }
  const ordered = [...groups.entries()].sort((a, b) => {
    if (b[1].length !== a[1].length) return b[1].length - a[1].length;
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  for (const [key, ids] of ordered) {
    const shown = ids.slice(0, 10);
    const more = ids.length > 10 ? ` +${ids.length - 10} more` : '';
    bullets.push(`- **${reasonLabel(key)} (${ids.length}):** ${shown.join(', ')}${more}`);
  }

  // (b) one bullet per spec that failed to render.
  for (const spec of specs) {
    if (spec.error) {
      bullets.push(
        `- **render error (1 spec):** ${codeSpan(specLabel(spec))} — ${clip(escapeCell(spec.error), CLIP.error)}`,
      );
    }
  }

  // (c) soft-count bullet. Soft criteria are scored by an agent verify, and
  // those scores live in the per-machine, gitignored `scorecard.json` (W6 #21
  // derive posture) — so a CI checkout never carries them and they read as
  // unscored here even when the author scored them locally. Say so, and point
  // at the one committed channel that DOES surface soft scores in CI.
  if ((counts.skipped || 0) > 0) {
    bullets.push(
      `- **soft — not scored in CI (${counts.skipped}):** scored by an agent verify locally; ` +
        'those scores live in the gitignored `scorecard.json`, so CI can’t see them. ' +
        'Set `historyCommitted: true` in `.validity/config.ts` to surface soft scores here.',
    );
  }

  if (bullets.length === 0) {
    lines.push(
      '_Everything in the frozen specs was either proven or explicitly scored — nothing unverifiable._',
    );
    return lines;
  }
  return lines.concat(capRows(bullets, CAPS.notValidated, 'unverifiable groups'));
}

/**
 * Delta status word for the base section. Statuses come from committed run
 * history at the merge-base — attacker-authored bytes, NOT trusted vocabulary
 * — so anything outside the known set is escaped + clipped, never rendered
 * raw (report-render escapes its twin of these fields the same way).
 */
function statusWord(s) {
  if (STATUS_BADGE[s]) return s;
  return clip(escapeCell(s), 40) || '—';
}

function baseSection(meta) {
  const base = meta.base;
  if (!base) return null;
  const sha7 = codeSpan(String(base.sha || '').slice(0, 7));
  const lines = [`### Changes vs base ${sha7}`];

  if (!Array.isArray(base.specs) || base.specs.length === 0) {
    lines.push(
      `_No Validity run history found at the merge-base (${sha7}) — set \`historyCommitted: true\` in \`.validity/config.ts\` and use \`fetch-depth: 0\` to enable regression deltas._`,
    );
    return lines;
  }

  const versionById = new Map((meta.specs || []).map((s) => [s.specId, s.version]));
  const regressed = [];
  const recovered = [];
  let unchanged = 0;
  let added = 0;
  let versionSpan = false;

  for (const s of base.specs) {
    if (typeof s.baseSpecVersion === 'number' && versionById.get(s.specId) !== s.baseSpecVersion) {
      versionSpan = true;
    }
    for (const d of s.deltas || []) {
      const idc = codeSpan(`${s.specId}/${d.criterionId}`);
      const move = `${statusWord(d.previousStatus)} → ${statusWord(d.currentStatus)}`;
      if (d.delta === 'regressed') {
        regressed.push(`- ❌ **regressed:** ${idc} ${move}`);
      } else if (d.delta === 'improved') {
        recovered.push(`- ✅ **recovered:** ${idc} ${move}`);
      } else if (d.delta === 'new') {
        added += 1;
      } else {
        unchanged += 1;
      }
    }
  }

  const bullets = regressed.concat(recovered);
  if (bullets.length === 0 && unchanged === 0 && added === 0) {
    lines.push('_No criterion-level changes vs the base run._');
  } else {
    lines.push(...capRows(bullets, CAPS.base, 'base deltas'));
    if (unchanged > 0 || added > 0) {
      const parts = [];
      if (unchanged > 0) parts.push(`${unchanged} unchanged`);
      if (added > 0) parts.push(`${added} new`);
      lines.push(`- ${parts.join(' · ')} since base`);
    }
  }
  if (versionSpan) {
    lines.push('_A spec was re-frozen between base and head — deltas span versions._');
  }
  return lines;
}

function footerLines(meta, artifactUrl) {
  const lines = [];
  if (artifactUrl) {
    lines.push(
      `📎 [Download the full report](${artifactUrl}) (screenshots + diff — in **your** repo's GitHub artifacts).`,
    );
  } else {
    lines.push(
      '_Full report.html uploaded as a build artifact (screenshots + diff stay in your storage)._',
    );
  }
  lines.push(
    meta.pass
      ? '✅ Every proof held and coverage met the floor.'
      : '❌ A hard/property check regressed or coverage is below the floor — see the report.',
    '> Soft (aesthetic) criteria are advisory and never block — they need an agent verify to score.',
  );
  return lines;
}

// ── The v1 (compact) body — today's comment, kept byte-for-byte ──
function compactBody(meta, artifactUrl) {
  const lines = ['<!-- validity-report -->', '## Validity — deterministic spec gate', ''];
  const callout = envBlockedCallout(meta);
  if (callout) lines.push(...callout, '');
  lines.push(`**${summaryLine(meta)}**`, '');
  if (artifactUrl) {
    lines.push(
      `📎 [Download the full report](${artifactUrl}) (screenshots + diff — in **your** repo's GitHub artifacts).`,
      '',
    );
  } else {
    lines.push(
      '_Full report.html uploaded as a build artifact (screenshots + diff stay in your storage)._',
      '',
    );
  }
  lines.push(
    meta.pass
      ? '✅ Every proof held and coverage met the floor.'
      : '❌ A hard/property check regressed or coverage is below the floor — see the report.',
    '',
    '> Soft (aesthetic) criteria are advisory and never block — they need an agent verify to score.',
  );
  return lines.join('\n');
}

// ── The v2 (fat) body — per-criterion verdict surface ──
function fatBody(meta, artifactUrl) {
  const verdict = meta.verdict || 'partial';
  const lines = [
    '<!-- validity-report -->',
    `## Validity — ${VERDICT_HEADER[verdict] || verdict.toUpperCase()}`,
  ];

  const callout = envBlockedCallout(meta);
  if (callout) lines.push('', ...callout);

  const badges = badgesLine(meta);
  if (badges) lines.push(badges);
  const score = scoreLine(meta);
  if (score) lines.push(score);

  lines.push(`**${summaryLine(meta)}**`, '');
  const census = specCensusLine(meta);
  if (census) lines.push(census, '');
  lines.push(...provenSection(meta), '');

  const scored = scoredSection(meta);
  if (scored) lines.push(...scored, '');

  lines.push(...notValidatedSection(meta), '');

  const base = baseSection(meta);
  if (base) lines.push(...base, '');

  lines.push(...footerLines(meta, artifactUrl));
  return lines.join('\n');
}

/**
 * Dispatch: fat body when the CLI wrote v2 (`meta.specs`) and detail isn't
 * `compact`; otherwise the v1 compact body. The absolute guard: if the assembled
 * body ever exceeds GitHub's limit, fall back to the compact body (which always
 * names the fail state) — so truncation can never publish a body GitHub rejects.
 */
function commentBody(meta, artifactUrl, detail) {
  const fat = detail !== 'compact' && Array.isArray(meta.specs) && meta.specs.length > 0;
  const body = fat ? fatBody(meta, artifactUrl) : compactBody(meta, artifactUrl);
  return body.length > MAX_BODY ? compactBody(meta, artifactUrl) : body;
}

module.exports = async function post({ github, context, core }) {
  const path = process.env.CHECK_JSON;
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (err) {
    core.warning(`Validity: could not read check metadata at ${path}: ${err.message}`);
    return;
  }
  core.setOutput('verdict', meta.verdict);

  const conclusion = conclusionFor(meta);
  const headSha = context.payload.pull_request
    ? context.payload.pull_request.head.sha
    : context.sha;

  // Check run — needs `checks: write`. Supports the `neutral` conclusion that a
  // commit status can't express, so a partial never reads as a clean green.
  try {
    await github.rest.checks.create({
      owner: context.repo.owner,
      repo: context.repo.repo,
      name: 'validity/verify',
      head_sha: headSha,
      status: 'completed',
      conclusion,
      output: { title: checkTitle(meta), summary: summaryLine(meta).slice(0, 65535) },
    });
  } catch (err) {
    core.warning(`Validity: could not post check run: ${err.message}`);
  }

  // PR comment — upsert by the hidden marker so re-runs update in place.
  const prNumber = context.payload.pull_request && context.payload.pull_request.number;
  if (process.env.POST_COMMENT === 'true' && prNumber) {
    const detail = process.env.COMMENT_DETAIL === 'compact' ? 'compact' : 'full';
    const body = commentBody(meta, process.env.ARTIFACT_URL || '', detail);
    try {
      const { data: comments } = await github.rest.issues.listComments({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: prNumber,
      });
      const existing = comments.find((c) => c.body && c.body.includes('<!-- validity-report -->'));
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
      core.warning(`Validity: could not upsert PR comment: ${err.message}`);
    }
  }
};

// Pure builders exported for unit tests (the action require()s the default export).
module.exports.conclusionFor = conclusionFor;
module.exports.summaryLine = summaryLine;
module.exports.checkTitle = checkTitle;
module.exports.envBlockedCallout = envBlockedCallout;
module.exports.envBlockedCount = envBlockedCount;
module.exports.commentBody = commentBody;
module.exports.compactBody = compactBody;
module.exports.fatBody = fatBody;
module.exports.badgesLine = badgesLine;
module.exports.scoreLine = scoreLine;
module.exports.specCensusLine = specCensusLine;
module.exports.provenSection = provenSection;
module.exports.scoredSection = scoredSection;
module.exports.notValidatedSection = notValidatedSection;
module.exports.baseSection = baseSection;
module.exports.capRows = capRows;
module.exports.escapeCell = escapeCell;
module.exports.codeSpan = codeSpan;
module.exports.clip = clip;
module.exports.MAX_BODY = MAX_BODY;
module.exports.SAFE_BUDGET = SAFE_BUDGET;
module.exports.CAPS = CAPS;
module.exports.CLIP = CLIP;
