import { describe, expect, it } from 'vitest';
import { judgeModelConfigSchema, scoringConfigSchema } from './schema.js';

describe('judgeModelConfigSchema (A6 — automated judge provider)', () => {
  it('accepts anthropic without a baseUrl', () => {
    const r = judgeModelConfigSchema.safeParse({
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-latest',
    });
    expect(r.success).toBe(true);
  });

  it('accepts openai with an explicit apiKeyEnv', () => {
    const r = judgeModelConfigSchema.safeParse({
      provider: 'openai',
      model: 'gpt-4o',
      apiKeyEnv: 'MY_OPENAI_KEY',
    });
    expect(r.success).toBe(true);
  });

  it('requires a baseUrl for openai-compatible', () => {
    const missing = judgeModelConfigSchema.safeParse({
      provider: 'openai-compatible',
      model: 'local',
    });
    expect(missing.success).toBe(false);
    if (!missing.success) {
      expect(missing.error.issues.some((i) => /baseUrl/.test(i.message))).toBe(true);
    }
    const ok = judgeModelConfigSchema.safeParse({
      provider: 'openai-compatible',
      model: 'local',
      baseUrl: 'https://host:1234/v1',
    });
    expect(ok.success).toBe(true);
  });

  it('rejects an unknown provider and an empty model', () => {
    expect(judgeModelConfigSchema.safeParse({ provider: 'gemini', model: 'x' }).success).toBe(
      false,
    );
    expect(judgeModelConfigSchema.safeParse({ provider: 'anthropic', model: '' }).success).toBe(
      false,
    );
  });
});

describe('scoringConfigSchema (A6)', () => {
  it("accepts judge: 'model' and a judgeModel block", () => {
    const r = scoringConfigSchema.safeParse({
      judge: 'model',
      judgeModel: { provider: 'anthropic', model: 'claude-3-5-sonnet-latest' },
    });
    expect(r.success).toBe(true);
  });

  it('still accepts the legacy judge modes with no judgeModel', () => {
    for (const judge of ['self', 'fresh-context', 'human'] as const) {
      expect(scoringConfigSchema.safeParse({ judge }).success).toBe(true);
    }
    expect(scoringConfigSchema.safeParse({}).success).toBe(true);
  });
});
