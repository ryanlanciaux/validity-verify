import { describe, expect, it, vi } from 'vitest';
import type { Signal, SignalKind } from '@validity.ai/verify-spec';
import {
  drainViaJudge,
  judgeConfigured,
  resolveJudgeDispatch,
  resolveJudgeRunner,
  routeOpenedSignals,
  type JudgeRunner,
} from './judge-routing.js';

function sig(kind: SignalKind, id = `${kind}:spec-1:*`): Signal {
  return {
    id,
    kind,
    severity: kind === 'regression' ? 'high' : 'medium',
    specId: 'spec-1',
    detail: 'x',
    at: '2026-07-20T00:00:00.000Z',
    status: 'open',
  };
}

describe('judgeConfigured (loose config probe)', () => {
  it('false for no scoring / no judgeModel', () => {
    expect(judgeConfigured(undefined)).toBe(false);
    expect(judgeConfigured({})).toBe(false);
    expect(judgeConfigured({ scoring: {} })).toBe(false);
    expect(judgeConfigured({ scoring: { judge: 'fresh-context' } })).toBe(false);
    expect(judgeConfigured({ scoring: { judgeModel: '' } })).toBe(false);
  });

  it('true for a string or object judgeModel', () => {
    expect(judgeConfigured({ scoring: { judgeModel: 'claude-opus' } })).toBe(true);
    expect(judgeConfigured({ scoring: { judgeModel: { provider: 'x', model: 'y' } } })).toBe(true);
  });
});

describe('resolveJudgeRunner (defensive dynamic resolution)', () => {
  it('resolves the real runJudge export from @validity.ai/verify-spec', async () => {
    // Real import path: the judge branch has merged, so the loop's runtime
    // probe must find the entry — this is the live loop↔judge integration.
    expect(await resolveJudgeRunner()).toBeTypeOf('function');
  });

  it('returns null when the import throws', async () => {
    expect(await resolveJudgeRunner(() => Promise.reject(new Error('no module')))).toBeNull();
  });

  it('adapts an exported runJudge when present (simulating the merged branch)', async () => {
    const runJudge = vi.fn();
    const runner = await resolveJudgeRunner(() => Promise.resolve({ runJudge }));
    expect(runner).toBeTypeOf('function');
    runner!({ projectRoot: '/p', config: {}, signal: sig('needs-scoring'), specId: 'spec-1' });
    expect(runJudge).toHaveBeenCalledOnce();
  });
});

describe('resolveJudgeDispatch (config AND runner both required)', () => {
  it('inactive when no judge configured, even if a runner would resolve', async () => {
    const d = await resolveJudgeDispatch({}, { resolveRunner: async () => vi.fn() });
    expect(d.active).toBe(false);
    expect(d.run).toBeNull();
  });

  it('inactive when configured but the entry is absent (degrades to agent)', async () => {
    const d = await resolveJudgeDispatch(
      { scoring: { judgeModel: 'm' } },
      { resolveRunner: async () => null },
    );
    expect(d.active).toBe(false);
  });

  it('active only when configured AND a runner resolves', async () => {
    const run = vi.fn();
    const d = await resolveJudgeDispatch(
      { scoring: { judgeModel: 'm' } },
      { resolveRunner: async () => run },
    );
    expect(d.active).toBe(true);
    expect(d.run).toBe(run);
  });
});

describe('routeOpenedSignals (kind-based split)', () => {
  const opened = [
    sig('regression'),
    sig('needs-scoring'),
    sig('needs-rescoring'),
    sig('recovered'),
  ];

  it('judge INACTIVE → everything dispatches the agent (today behavior)', () => {
    const r = routeOpenedSignals(opened, false);
    expect(r.toJudge).toEqual([]);
    expect(r.toAgent).toEqual(opened);
  });

  it('judge ACTIVE → only needs-scoring / needs-rescoring peel off to the judge', () => {
    const r = routeOpenedSignals(opened, true);
    expect(r.toJudge.map((s) => s.kind)).toEqual(['needs-scoring', 'needs-rescoring']);
    // regression ALWAYS dispatches the agent, judge or not.
    expect(r.toAgent.map((s) => s.kind)).toEqual(['regression', 'recovered']);
  });

  it('native-origin signals route identically (routing keys on kind, not runtime)', () => {
    // A native spec produces the SAME Signal shape (no runtime field), so a
    // native regression and a native needs-scoring split exactly like web ones.
    const nativeReg = {
      ...sig('regression'),
      specId: 'spec-native',
      id: 'regression:spec-native:*',
    };
    const nativeScore = {
      ...sig('needs-scoring'),
      specId: 'spec-native',
      id: 'needs-scoring:spec-native:*',
    };
    const r = routeOpenedSignals([nativeReg, nativeScore], true);
    expect(r.toJudge).toEqual([nativeScore]);
    expect(r.toAgent).toEqual([nativeReg]);
  });
});

describe('drainViaJudge (fallback on failure)', () => {
  const log = () => {};

  it('drains all signals and returns none undrained on success', async () => {
    const run: JudgeRunner = vi.fn(async () => undefined);
    const undrained = await drainViaJudge(run, [sig('needs-scoring'), sig('needs-rescoring')], {
      projectRoot: '/p',
      config: {},
      log,
    });
    expect(undrained).toEqual([]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('returns the signals a throwing judge could not drain (for agent fallback)', async () => {
    const bad = sig('needs-scoring', 'needs-scoring:spec-bad:*');
    const run: JudgeRunner = vi.fn(async (input) => {
      if (input.signal.id === bad.id) throw new Error('judge boom');
    });
    const undrained = await drainViaJudge(run, [sig('needs-rescoring'), bad], {
      projectRoot: '/p',
      config: {},
      log,
    });
    expect(undrained).toEqual([bad]);
  });
});
