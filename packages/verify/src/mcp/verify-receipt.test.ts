/**
 * The verify RECEIPT (B1) — "did my one-off verify actually move the project's
 * standing state?", answered truthfully.
 *
 * Two halves: the pure projection/wording (no IO), and the truthfulness of the
 * receipt against a REAL fold on disk for the three outcomes an agent can hit —
 * a frozen spec (written), a draft spec (deliberately not written), and an
 * unreadable scorecard (refused, and the never-reconcile-from-corrupt rule
 * still holds).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  foldVerifyIntoScorecard,
  loadScorecard,
  saveScorecard,
  scorecardPath,
  type CriterionVerdict,
  type Spec,
} from '@validity.ai/verify-spec';
import { buildVerifyReceipt, receiptLine, RECEIPT_REASON_URL_MODE } from './verify-receipt.js';

const T1 = '2026-02-01T00:00:00.000Z';

function spec(over: Partial<Spec> = {}): Spec {
  return {
    id: 'spec-receipt',
    version: 1,
    status: 'frozen',
    hash: 'hash-1',
    source: { prompt: 'p', createdBy: 'agent' },
    criteria: [
      { id: 'AC-1', text: 'no console errors', tier: 'hard' },
      { id: 'AC-2', text: 'looks polished', tier: 'soft' },
    ],
    createdAt: T1,
    ...over,
  };
}

const VERDICTS: CriterionVerdict[] = [
  { id: 'AC-1', tier: 'hard', status: 'pass', detail: '0 console errors' },
  { id: 'AC-2', tier: 'soft', status: 'unverifiable' },
];

describe('receiptLine (the one line an agent can quote back)', () => {
  it('names the spec, the signal movement, and the history append', () => {
    const line = receiptLine({
      runId: 'run_1',
      specsTouched: ['spec-receipt'],
      ledgerWritten: true,
      signalsRaised: [{ kind: 'needs-scoring', specId: 'spec-receipt', criterionId: 'AC-2' }],
      signalsResolved: [],
      historyAppended: true,
      origin: 'local',
    });
    expect(line).toBe(
      'Ledger: scorecard updated for spec-receipt · 1 signal raised · history appended',
    );
  });

  it('says NOT written, in plain words, for each cause', () => {
    const base = {
      runId: 'run_1',
      specsTouched: [],
      ledgerWritten: false,
      signalsRaised: [],
      signalsResolved: [],
      historyAppended: false,
      origin: 'local' as const,
    };
    expect(receiptLine({ ...base, ledgerReason: 'draft-spec' })).toBe(
      'Ledger: NOT written — draft spec (freeze it to track standings)',
    );
    expect(receiptLine({ ...base, ledgerReason: RECEIPT_REASON_URL_MODE })).toContain(
      'URL mode produces no mechanical verdicts',
    );
    // An IO error carries its own message rather than a generic label.
    expect(receiptLine({ ...base, ledgerReason: 'io-error' }, 'ENOTDIR: not a directory')).toBe(
      'Ledger: NOT written — ENOTDIR: not a directory',
    );
  });
});

describe('buildVerifyReceipt — truthful against a real fold', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-receipt-'));
  });

  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  it('FROZEN spec: written=true, the spec is named, and the raised signal is reported', () => {
    const fold = foldVerifyIntoScorecard(projectRoot, {
      spec: spec(),
      verdicts: VERDICTS,
      now: T1,
    });
    const receipt = buildVerifyReceipt({ runId: 'run_1', origin: 'local', fold });

    expect(receipt.ledgerWritten).toBe(true);
    expect(receipt.ledgerReason).toBeUndefined();
    expect(receipt.specsTouched).toEqual(['spec-receipt']);
    // The unscored soft criterion opens `needs-scoring` — the receipt says so.
    expect(receipt.signalsRaised.some((s) => s.kind === 'needs-scoring')).toBe(true);
    // The local drift feed (`history/signals.jsonl`) is ALWAYS appended when a
    // transition happens — `historyCommitted` only governs whether that file is
    // committed — so a raised signal means a row landed.
    expect(receipt.historyAppended).toBe(true);
    // Truthful: the claim matches what is on disk.
    expect(loadScorecard(projectRoot)!.specs['spec-receipt']!.criteria['AC-1']!.status).toBe(
      'pass',
    );
  });

  it('DRAFT spec: written=false with reason draft-spec, and nothing lands on disk', () => {
    const fold = foldVerifyIntoScorecard(projectRoot, {
      spec: spec({ status: 'draft', hash: undefined }),
      verdicts: VERDICTS,
    });
    const receipt = buildVerifyReceipt({ runId: 'run_1', origin: 'local', fold });

    expect(receipt.ledgerWritten).toBe(false);
    expect(receipt.ledgerReason).toBe('draft-spec');
    expect(receipt.specsTouched).toEqual([]);
    expect(loadScorecard(projectRoot)).toBeNull();
    expect(receiptLine(receipt)).toContain('freeze it to track standings');
  });

  it('UNREADABLE scorecard: written=false, and the corrupt file is NOT reconciled over', () => {
    // Seed a real scorecard first, then corrupt it — the never-reconcile-from-
    // corrupt rule (W4 #11) must still hold, and now it is also REPORTED.
    foldVerifyIntoScorecard(projectRoot, { spec: spec(), verdicts: VERDICTS, now: T1 });
    saveScorecard(projectRoot, loadScorecard(projectRoot)!);
    const corrupt = '{ this is not json';
    writeFileSync(scorecardPath(projectRoot), corrupt);

    const fold = foldVerifyIntoScorecard(projectRoot, {
      spec: spec(),
      verdicts: VERDICTS,
      now: T1,
    });
    const receipt = buildVerifyReceipt({ runId: 'run_2', origin: 'local', fold });

    expect(receipt.ledgerWritten).toBe(false);
    expect(receipt.ledgerReason).toBe('scorecard-unreadable');
    // Untouched — the fold refused rather than dropping every other spec's entry.
    expect(readFileSync(scorecardPath(projectRoot), 'utf-8')).toBe(corrupt);
  });

  it('URL mode (no fold at all): written=false with the url-mode reason', () => {
    const receipt = buildVerifyReceipt({
      runId: 'run_3',
      origin: 'ci',
      ledgerReason: RECEIPT_REASON_URL_MODE,
    });
    expect(receipt.ledgerWritten).toBe(false);
    expect(receipt.ledgerReason).toBe(RECEIPT_REASON_URL_MODE);
    expect(receipt.origin).toBe('ci');
    expect(receipt.specsTouched).toEqual([]);
  });
});
