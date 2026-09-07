/**
 * `verify --all` save posture by run origin (B4).
 *
 * The rule: the sweep owns standing state on a developer's machine and owns
 * nothing on a CI runner. A local `validity verify --all` is a full tick and
 * must leave the scorecard + signal queue current even if `watch` never runs;
 * a CI sweep must leave the checkout byte-identical to what it cloned.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadScorecard,
  loadSignals,
  scorecardPath,
  signalsPath,
  type Scorecard,
  type Signal,
} from '@validity.ai/verify-spec';
import { persistStandingsForOrigin } from './verify-all.js';

const NOW = '2026-05-01T00:00:00.000Z';

const scorecard = (): Scorecard => ({
  version: 1,
  updatedAt: NOW,
  specs: {
    'spec-a': {
      specId: 'spec-a',
      version: 1,
      hash: 'h',
      criteria: {
        'AC-1': { id: 'AC-1', tier: 'hard', status: 'fail', updatedAt: NOW },
      },
      updatedAt: NOW,
    },
  },
});

const signals = (): Signal[] => [
  {
    id: 'sig-1',
    kind: 'regression',
    specId: 'spec-a',
    criterionId: 'AC-1',
    status: 'open',
    createdAt: NOW,
    updatedAt: NOW,
  } as Signal,
];

describe('persistStandingsForOrigin', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-b4-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('LOCAL: writes the scorecard AND the signal queue together', () => {
    const wrote = persistStandingsForOrigin({
      projectRoot,
      origin: 'local',
      scorecard: scorecard(),
      signals: signals(),
    });
    expect(wrote).toBe(true);
    expect(loadScorecard(projectRoot)!.specs['spec-a']!.criteria['AC-1']!.status).toBe('fail');
    // The regression is queued, not just recorded — the dashboard reads this.
    expect(loadSignals(projectRoot).map((s) => s.id)).toContain('sig-1');
  });

  it('CI: writes nothing at all — the checkout stays clean', () => {
    const wrote = persistStandingsForOrigin({
      projectRoot,
      origin: 'ci',
      scorecard: scorecard(),
      signals: signals(),
    });
    expect(wrote).toBe(false);
    expect(existsSync(scorecardPath(projectRoot))).toBe(false);
    expect(existsSync(signalsPath(projectRoot))).toBe(false);
  });

  it('a write failure warns and reports false — it never throws into the sweep', () => {
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    // A file where the .validity directory must go: every write below fails.
    rmSync(projectRoot, { recursive: true, force: true });
    const wrote = persistStandingsForOrigin({
      projectRoot: resolve(projectRoot, 'does', 'not', 'exist', '\0bad'),
      origin: 'local',
      scorecard: scorecard(),
      signals: signals(),
    });
    expect(wrote).toBe(false);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]![0])).toContain('could not persist standings');
  });
});
