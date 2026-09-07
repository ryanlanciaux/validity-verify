/**
 * The verify RECEIPT — proof, citable by the agent,
 * that a one-off `validity__verify` actually moved the project's standing
 * state.
 *
 * Before this, `foldVerifyIntoScorecard` was silent best-effort: an agent
 * running verify → submit_report with `validity watch` never started could not
 * tell a successful scorecard write from a swallowed IO error, a draft spec
 * that deliberately folds nothing, or a corrupt scorecard the fold refused to
 * clobber. All three now come back NAMED, in `structuredContent.receipt` and in
 * one line of text.
 *
 * Pure: takes the fold's result and returns data. Lives outside server.ts so
 * the wording is test-pinned without booting a handler.
 */
import type { FoldResult, FoldSignalRef, RunOrigin } from '@validity.ai/verify-spec';

/**
 * ADD-ONLY sibling key of `verdict` on the verify tool result. Nothing here
 * feeds `status`/`signedOff` — it describes the WRITE, not the judgement.
 */
export interface VerifyReceipt {
  runId: string;
  /** Spec ids whose scorecard entry this verify wrote. Empty when nothing was written. */
  specsTouched: string[];
  /** Did the scorecard + signal queue actually get persisted by this verify? */
  ledgerWritten: boolean;
  /** Machine-readable cause when `ledgerWritten` is false. Omitted when written. */
  ledgerReason?: string;
  signalsRaised: FoldSignalRef[];
  signalsResolved: FoldSignalRef[];
  /** Did the durable drift ledger (`.validity/history/signals.jsonl`) get an append? */
  historyAppended: boolean;
  origin: RunOrigin;
}

/** Reasons this layer contributes on top of the fold's own (core) taxonomy. */
export const RECEIPT_REASON_NO_SPEC = 'no-frozen-spec';
export const RECEIPT_REASON_URL_MODE = 'url-mode-no-mechanical-verdicts';

/**
 * Human phrasing per reason. Anything unrecognized (an `io-error`'s message,
 * a future caller's reason) is printed verbatim — never swallowed, because an
 * unexplained "NOT written" is exactly the silence this feature removes.
 */
function explainReason(reason: string, error?: string): string {
  switch (reason) {
    case 'draft-spec':
      return 'draft spec (freeze it to track standings)';
    case 'scorecard-unreadable':
      return '.validity/scorecard.json is unreadable — standings left untouched rather than clobbered';
    case 'io-error':
      return error ?? 'scorecard write failed';
    case 'native-unverifiable':
      return 'the device produced no confirmed render';
    case RECEIPT_REASON_NO_SPEC:
      return 'no frozen spec in scope (nothing to fold — plan/freeze one to track standings)';
    case RECEIPT_REASON_URL_MODE:
      return 'URL mode produces no mechanical verdicts';
    default:
      return error ? `${reason} — ${error}` : reason;
  }
}

/**
 * Build the receipt from the fold's own account of what it did. `fold` is
 * absent for surfaces that never call the fold (URL mode, a spec-less
 * isolation run); those pass an explicit `ledgerReason`.
 */
export function buildVerifyReceipt(args: {
  runId: string;
  origin: RunOrigin;
  fold?: FoldResult;
  /** Reason to report when no fold ran at all. Ignored when `fold` is present. */
  ledgerReason?: string;
}): VerifyReceipt {
  const { runId, origin, fold } = args;
  if (!fold) {
    return {
      runId,
      specsTouched: [],
      ledgerWritten: false,
      ledgerReason: args.ledgerReason ?? RECEIPT_REASON_NO_SPEC,
      signalsRaised: [],
      signalsResolved: [],
      historyAppended: false,
      origin,
    };
  }
  return {
    runId,
    specsTouched: fold.written ? [fold.specId] : [],
    ledgerWritten: fold.written,
    ...(fold.written ? {} : { ledgerReason: fold.reason ?? 'unknown' }),
    signalsRaised: fold.signalsOpened,
    signalsResolved: fold.signalsResolved,
    historyAppended: fold.historyAppended,
    origin,
  };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * The one line of text that rides in the verify response's `content` array.
 * Deliberately terse and always present when a spec was in scope: the agent
 * should be able to quote it back as the receipt.
 */
export function receiptLine(receipt: VerifyReceipt, foldError?: string): string {
  if (!receipt.ledgerWritten) {
    return `Ledger: NOT written — ${explainReason(receipt.ledgerReason ?? 'unknown', foldError)}`;
  }
  const parts = [`scorecard updated for ${receipt.specsTouched.join(', ')}`];
  if (receipt.signalsRaised.length > 0) {
    parts.push(`${plural(receipt.signalsRaised.length, 'signal')} raised`);
  }
  if (receipt.signalsResolved.length > 0) {
    parts.push(`${plural(receipt.signalsResolved.length, 'signal')} resolved`);
  }
  parts.push(receipt.historyAppended ? 'history appended' : 'no signal transitions');
  return `Ledger: ${parts.join(' · ')}`;
}
