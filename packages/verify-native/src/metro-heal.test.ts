/**
 * Unit tests for the companion-Metro auto-heal decision layer.
 *
 * Everything here is pure or fake-fs, because the thing under test is not "does
 * a restart work" (the 2026-07-29 isolation run answered that on a real device)
 * — it is "when may Validity restart, and when must it refuse". The refusals are
 * the load-bearing half: an unbounded auto-heal is a restart loop that hides a
 * broken environment behind a bundler that was never the problem.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  bundlerEpochStartMs,
  capturesOnBundler,
  decideMetroHeal,
  decidePreventiveRecycle,
  DEFAULT_METRO_RECYCLE_CAPTURES,
  invalidateMetroContentMarker,
  MAX_METRO_AUTO_RESTARTS_PER_PROCESS,
  metroAutoRestartCount,
  metroHealJournalPath,
  noteMetroAutoRestart,
  readMetroHealRecord,
  resetMetroAutoRestartCount,
  writeMetroHealRecord,
  type HealJournalFs,
  type MetroHealRecord,
} from './metro-heal.js';

function fakeFs(seed: Record<string, string> = {}): HealJournalFs & { files: Map<string, string> } {
  const files = new Map(Object.entries(seed));
  return {
    files,
    readFile: (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    writeFile: (p, body) => {
      files.set(p, body);
    },
    remove: (p) => {
      files.delete(p);
    },
  };
}

describe('the reactive heal decision', () => {
  const base = { restartsSoFar: 0, lastHeal: null, confirmedSinceLastHeal: true };

  it('heals a metro-decayed capture', () => {
    const d = decideMetroHeal({ ...base, diagnosisCause: 'metro-decayed' });
    expect(d.heal).toBe(true);
    expect(d.reason).toMatch(/restarting it and retrying/);
  });

  it('refuses every OTHER cause — restarting the bundler is not a general remedy', () => {
    for (const cause of [
      'no-native-session',
      'dev-launcher-home',
      'session-decay',
      'render-failure',
      'phantom-device-claim',
      undefined,
    ]) {
      expect(decideMetroHeal({ ...base, diagnosisCause: cause }).heal).toBe(false);
    }
  });

  it('spends its per-run budget once: a second metro-decayed in the same run is REPORTED, not retried', () => {
    const d = decideMetroHeal({
      ...base,
      diagnosisCause: 'metro-decayed',
      restartsSoFar: MAX_METRO_AUTO_RESTARTS_PER_PROCESS,
    });
    expect(d.heal).toBe(false);
    expect(d.reason).toMatch(/already auto-restarted/);
  });

  it('refuses when the PREVIOUS heal recovered nothing and nothing has rendered since', () => {
    const lastHeal: MetroHealRecord = {
      ts: '2026-07-29T12:00:00.000Z',
      trigger: 'decay-diagnosis',
      outcome: 'failed',
    };
    const d = decideMetroHeal({
      ...base,
      diagnosisCause: 'metro-decayed',
      lastHeal,
      confirmedSinceLastHeal: false,
    });
    expect(d.heal).toBe(false);
    expect(d.reason).toContain('2026-07-29T12:00:00.000Z');
    expect(d.reason).toMatch(/nothing has rendered since/);
  });

  it('allows a heal again once something HAS rendered since the failed one (the episode ended)', () => {
    const d = decideMetroHeal({
      ...base,
      diagnosisCause: 'metro-decayed',
      lastHeal: { ts: '2026-07-29T12:00:00.000Z', trigger: 'decay-diagnosis', outcome: 'failed' },
      confirmedSinceLastHeal: true,
    });
    expect(d.heal).toBe(true);
  });

  it('allows a heal after a heal that WORKED — a later collapse is a new episode', () => {
    const d = decideMetroHeal({
      ...base,
      diagnosisCause: 'metro-decayed',
      lastHeal: {
        ts: '2026-07-29T12:00:00.000Z',
        trigger: 'decay-diagnosis',
        outcome: 'recovered',
      },
      confirmedSinceLastHeal: false,
    });
    expect(d.heal).toBe(true);
  });
});

describe('the preventive recycle decision', () => {
  const base = { capturesOnBundler: 40, restartsSoFar: 0 } as const;

  it('recycles an Android bundler past the default threshold', () => {
    const d = decidePreventiveRecycle({ ...base, platform: 'android' });
    expect(d.recycle).toBe(true);
    expect(d.threshold).toBe(DEFAULT_METRO_RECYCLE_CAPTURES);
    expect(d.reason).toMatch(/40 captures/);
  });

  it('recycles BELOW the measured 40-50 cliff, not at it', () => {
    expect(DEFAULT_METRO_RECYCLE_CAPTURES).toBeLessThan(40);
    expect(
      decidePreventiveRecycle({
        platform: 'android',
        capturesOnBundler: DEFAULT_METRO_RECYCLE_CAPTURES,
        restartsSoFar: 0,
      }).recycle,
    ).toBe(true);
    expect(
      decidePreventiveRecycle({
        platform: 'android',
        capturesOnBundler: DEFAULT_METRO_RECYCLE_CAPTURES - 1,
        restartsSoFar: 0,
      }).recycle,
    ).toBe(false);
  });

  it('is OFF by default on iOS — the cliff was measured on Android only', () => {
    const d = decidePreventiveRecycle({ ...base, platform: 'ios' });
    expect(d.recycle).toBe(false);
    expect(d.reason).toMatch(/metroRecycleAfterCaptures/);
  });

  it('an explicit threshold opts iOS in', () => {
    expect(decidePreventiveRecycle({ ...base, platform: 'ios', configured: 25 }).recycle).toBe(
      true,
    );
  });

  it('`false` (and 0) disable it outright, on either platform', () => {
    for (const configured of [false, 0] as const) {
      const d = decidePreventiveRecycle({ ...base, platform: 'android', configured });
      expect(d.recycle).toBe(false);
      expect(d.reason).toMatch(/disabled in config/);
    }
  });

  it('shares the per-run budget with the reactive heal — no second restart in one run', () => {
    const d = decidePreventiveRecycle({
      ...base,
      platform: 'android',
      restartsSoFar: MAX_METRO_AUTO_RESTARTS_PER_PROCESS,
    });
    expect(d.recycle).toBe(false);
    expect(d.reason).toMatch(/budget/);
  });

  it('an unknown bundler epoch (0 captures) never recycles', () => {
    expect(
      decidePreventiveRecycle({ platform: 'android', capturesOnBundler: 0, restartsSoFar: 0 })
        .recycle,
    ).toBe(false);
  });
});

describe('the per-process budget', () => {
  beforeEach(() => resetMetroAutoRestartCount());

  it('counts up and resets', () => {
    expect(metroAutoRestartCount()).toBe(0);
    expect(noteMetroAutoRestart()).toBe(1);
    expect(metroAutoRestartCount()).toBe(1);
    resetMetroAutoRestartCount();
    expect(metroAutoRestartCount()).toBe(0);
  });
});

describe('the heal journal', () => {
  it('round-trips a record', () => {
    const fs = fakeFs();
    const record: MetroHealRecord = {
      ts: '2026-07-29T12:14:36.000Z',
      trigger: 'preventive',
      outcome: 'recovered',
      specId: 'spec-a7fd',
      capturesOnBundler: 31,
      bundlerEpochStartedAt: '2026-07-29T12:14:36.000Z',
    };
    writeMetroHealRecord('/app', record, fs);
    expect(fs.files.has(metroHealJournalPath('/app'))).toBe(true);
    expect(readMetroHealRecord('/app', fs)).toEqual(record);
  });

  it('reads an absent / corrupt journal as "no heal on record" rather than blocking the heal', () => {
    expect(readMetroHealRecord('/app', fakeFs())).toBeNull();
    expect(
      readMetroHealRecord('/app', fakeFs({ [metroHealJournalPath('/app')]: '{oops' })),
    ).toBeNull();
    expect(
      readMetroHealRecord('/app', fakeFs({ [metroHealJournalPath('/app')]: '[]' })),
    ).toBeNull();
  });

  it('an unknown outcome degrades to `failed` — the bounding side, never the permissive one', () => {
    const fs = fakeFs({
      [metroHealJournalPath('/app')]: JSON.stringify({ ts: 'T', outcome: 'maybe?' }),
    });
    expect(readMetroHealRecord('/app', fs)?.outcome).toBe('failed');
  });

  it('an unwritable app dir never throws', () => {
    const fs = fakeFs();
    fs.writeFile = () => {
      throw new Error('EROFS');
    };
    expect(() =>
      writeMetroHealRecord('/app', { ts: 'T', trigger: 'preventive', outcome: 'failed' }, fs),
    ).not.toThrow();
  });
});

describe('the bundler epoch', () => {
  it('takes the LATER of the owner marker and the journal — a human restart wins over stale bookkeeping', () => {
    const ms = bundlerEpochStartMs({
      ownerStartedAt: '2026-07-29T12:56:05.000Z',
      journalEpoch: '2026-07-29T11:22:52.000Z',
    });
    expect(ms).toBe(Date.parse('2026-07-29T12:56:05.000Z'));
  });

  it('falls back to whichever single source exists (the `expo run` bundler has no owner marker)', () => {
    expect(bundlerEpochStartMs({ journalEpoch: '2026-07-29T11:00:00.000Z' })).toBe(
      Date.parse('2026-07-29T11:00:00.000Z'),
    );
    expect(bundlerEpochStartMs({ ownerStartedAt: '2026-07-29T11:00:00.000Z' })).toBe(
      Date.parse('2026-07-29T11:00:00.000Z'),
    );
  });

  it('is undefined when nothing is known or parseable', () => {
    expect(bundlerEpochStartMs({})).toBeUndefined();
    expect(bundlerEpochStartMs({ ownerStartedAt: 'not-a-date' })).toBeUndefined();
  });

  it('counts only captures at or after the epoch', () => {
    const rows = [
      { ts: '2026-07-29T11:00:00.000Z' },
      { ts: '2026-07-29T12:00:00.000Z' },
      { ts: '2026-07-29T13:00:00.000Z' },
    ];
    expect(capturesOnBundler(rows, Date.parse('2026-07-29T12:00:00.000Z'))).toBe(2);
  });

  it('drops unreadable timestamps rather than over-counting a healthy bundler into a restart', () => {
    const rows = [{ ts: 'nonsense' }, { ts: '2026-07-29T13:00:00.000Z' }];
    expect(capturesOnBundler(rows, Date.parse('2026-07-29T12:00:00.000Z'))).toBe(1);
  });

  it('counts nothing when the epoch is unknown, so no preventive recycle can fire', () => {
    expect(capturesOnBundler([{ ts: '2026-07-29T13:00:00.000Z' }], undefined)).toBe(0);
  });
});

describe('the restart action', () => {
  it('removes the content marker — the sanctioned managed-restart trigger', () => {
    const fs = fakeFs({ '/app/.validity-metro-content': 'hash-1' });
    expect(invalidateMetroContentMarker('/app/.validity-metro-content', fs)).toBe(true);
    expect(fs.files.has('/app/.validity-metro-content')).toBe(false);
  });

  it('reports failure instead of throwing, so a read-only app dir degrades to "no heal"', () => {
    const fs = fakeFs();
    fs.remove = () => {
      throw new Error('EROFS');
    };
    expect(invalidateMetroContentMarker('/app/.validity-metro-content', fs)).toBe(false);
  });
});
