import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect } from 'vitest';
import type { JudgeClientError } from './judge-client.js';
import {
  callJudgeModel,
  judgeApiKeyEnv,
  readJudgeApiKey,
  validateJudgeReply,
  type JudgeCallRequest,
} from './judge-client.js';
import type { JudgeModelConfig } from './types.js';

/** A fetch double that records its calls and returns a canned response. */
function fakeFetch(resp: { ok?: boolean; status?: number; jsonBody?: unknown; textBody?: string }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return {
      ok: resp.ok ?? true,
      status: resp.status ?? 200,
      json: async () => resp.jsonBody,
      text: async () => resp.textBody ?? '',
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function bodyOf(calls: Array<{ init: RequestInit }>): Record<string, unknown> {
  return JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
}

const anthropicCfg: JudgeModelConfig = { provider: 'anthropic', model: 'claude-3-5-sonnet-latest' };
const openaiCfg: JudgeModelConfig = { provider: 'openai', model: 'gpt-4o' };

const baseReq: Omit<JudgeCallRequest, 'config' | 'fetchImpl'> = {
  apiKey: 'sk-SECRET-should-never-leak',
  system: 'You are the judge.',
  userText: 'Score the rubric.',
  screenshots: [{ screenshotId: 'Button:default', label: 'Button', base64: 'AAAABBBB' }],
};

describe('judgeApiKeyEnv / readJudgeApiKey', () => {
  it('defaults ANTHROPIC_API_KEY for anthropic, OPENAI_API_KEY otherwise', () => {
    expect(judgeApiKeyEnv(anthropicCfg)).toBe('ANTHROPIC_API_KEY');
    expect(judgeApiKeyEnv(openaiCfg)).toBe('OPENAI_API_KEY');
    expect(judgeApiKeyEnv({ provider: 'openai-compatible', model: 'm', baseUrl: 'x' })).toBe(
      'OPENAI_API_KEY',
    );
  });

  it('honors an explicit apiKeyEnv and reads it at call time', () => {
    const cfg: JudgeModelConfig = { provider: 'openai', model: 'm', apiKeyEnv: 'MY_KEY' };
    expect(judgeApiKeyEnv(cfg)).toBe('MY_KEY');
    expect(readJudgeApiKey(cfg, { MY_KEY: 'abc' } as NodeJS.ProcessEnv)).toBe('abc');
    expect(readJudgeApiKey(cfg, { MY_KEY: '   ' } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(readJudgeApiKey(cfg, {} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});

describe('validateJudgeReply', () => {
  const good = JSON.stringify({
    scores: [
      { id: 'AC-1', status: 'pass', reasoning: 'the button reads Save', screenshotIds: ['s1'] },
    ],
    scoredBy: 'anthropic/claude-3-5-sonnet',
  });

  it('accepts a well-formed reply', () => {
    const r = validateJudgeReply(good);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.scores[0]!.id).toBe('AC-1');
  });

  it('accepts a reply wrapped in a ```json fence', () => {
    expect(validateJudgeReply('```json\n' + good + '\n```').ok).toBe(true);
  });

  it('accepts a reply with surrounding prose', () => {
    expect(validateJudgeReply('Here are my scores:\n' + good + '\nThanks!').ok).toBe(true);
  });

  it('rejects non-JSON', () => {
    const r = validateJudgeReply('I refuse to answer.');
    expect(r.ok).toBe(false);
  });

  it('rejects a missing scoredBy', () => {
    const r = validateJudgeReply(
      JSON.stringify({
        scores: [{ id: 'AC-1', status: 'pass', reasoning: 'x', screenshotIds: ['s1'] }],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/scoredBy/);
  });

  it('rejects an invalid status', () => {
    const r = validateJudgeReply(
      JSON.stringify({
        scores: [{ id: 'AC-1', status: 'maybe', reasoning: 'x', screenshotIds: ['s1'] }],
        scoredBy: 'm',
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/status: must be one of/);
  });

  it('rejects a missing screenshotIds array', () => {
    const r = validateJudgeReply(
      JSON.stringify({ scores: [{ id: 'AC-1', status: 'pass', reasoning: 'x' }], scoredBy: 'm' }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/screenshotIds/);
  });

  it('rejects an out-of-range numeric score', () => {
    const r = validateJudgeReply(
      JSON.stringify({
        scores: [{ id: 'AC-1', status: 'pass', reasoning: 'x', screenshotIds: ['s1'], score: 1.5 }],
        scoredBy: 'm',
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/score: when present/);
  });

  it('rejects an empty scores array', () => {
    expect(validateJudgeReply(JSON.stringify({ scores: [], scoredBy: 'm' })).ok).toBe(false);
  });
});

describe('callJudgeModel — Anthropic wire shape', () => {
  it('POSTs the Messages API with x-api-key + base64 image blocks', async () => {
    const { fn, calls } = fakeFetch({
      jsonBody: { content: [{ type: 'text', text: '{"scores":[],"scoredBy":"x"}' }] },
    });
    const res = await callJudgeModel({ ...baseReq, config: anthropicCfg, fetchImpl: fn });
    expect(res.raw).toContain('scoredBy');
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0]!.init.redirect).toBe('error');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(baseReq.apiKey);
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = bodyOf(calls);
    expect(body.model).toBe('claude-3-5-sonnet-latest');
    expect(body.system).toBe('You are the judge.');
    const content = (body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!
      .content;
    const image = content.find((b) => b.type === 'image') as {
      source: { data: string; media_type: string };
    };
    expect(image.source.data).toBe('AAAABBBB');
    expect(image.source.media_type).toBe('image/png');
  });
});

describe('callJudgeModel — OpenAI wire shape', () => {
  it('POSTs chat/completions with Bearer auth + data-URI image_url', async () => {
    const { fn, calls } = fakeFetch({
      jsonBody: { choices: [{ message: { content: '{"scores":[],"scoredBy":"x"}' } }] },
    });
    const res = await callJudgeModel({ ...baseReq, config: openaiCfg, fetchImpl: fn });
    expect(res.raw).toContain('scoredBy');
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${baseReq.apiKey}`);
    const body = bodyOf(calls);
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0]!.role).toBe('system');
    const userContent = messages[1]!.content as Array<Record<string, unknown>>;
    const image = userContent.find((b) => b.type === 'image_url') as { image_url: { url: string } };
    expect(image.image_url.url).toBe('data:image/png;base64,AAAABBBB');
  });

  it('routes an openai-compatible provider to its baseUrl', async () => {
    const { fn, calls } = fakeFetch({
      jsonBody: { choices: [{ message: { content: '{"scores":[],"scoredBy":"x"}' } }] },
    });
    await callJudgeModel({
      ...baseReq,
      config: {
        provider: 'openai-compatible',
        model: 'local-vlm',
        baseUrl: 'https://host:1234/v1/',
      },
      fetchImpl: fn,
    });
    expect(calls[0]!.url).toBe('https://host:1234/v1/chat/completions');
  });
});

describe('callJudgeModel — failure surfaces (never a pass, never a key leak)', () => {
  it('throws a key-free JudgeClientError on a non-2xx status', async () => {
    const { fn } = fakeFetch({ ok: false, status: 429, textBody: 'rate limit exceeded' });
    await expect(
      callJudgeModel({ ...baseReq, config: openaiCfg, fetchImpl: fn }),
    ).rejects.toMatchObject({ name: 'JudgeClientError' });
    try {
      await callJudgeModel({ ...baseReq, config: openaiCfg, fetchImpl: fn });
    } catch (err) {
      const e = err as JudgeClientError;
      expect(e.reason).toMatch(/429/);
      expect(e.reason).not.toContain(baseReq.apiKey);
    }
  });

  it.each(['http', 'network', 'json'] as const)(
    'omits untrusted %s diagnostics that echo credentials',
    async (failure) => {
      const diagnostic = `Invalid credential: ${baseReq.apiKey} (${baseReq.apiKey.slice(0, 12)})`;
      const fn = (async () => {
        if (failure === 'network') throw new Error(diagnostic);
        return {
          ok: failure !== 'http',
          status: 401,
          text: async () => diagnostic,
          json: async () => {
            throw new SyntaxError(diagnostic);
          },
        } as unknown as Response;
      }) as typeof fetch;
      const reason = {
        http: 'openai returned HTTP 401',
        network: 'openai request failed: network error',
        json: 'openai response was not JSON',
      }[failure];
      await expect(
        callJudgeModel({ ...baseReq, config: openaiCfg, fetchImpl: fn }),
      ).rejects.toMatchObject({ name: 'JudgeClientError', message: reason, reason });
    },
  );

  it('reports a timeout as a request timeout', async () => {
    const fn = (async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }) as unknown as typeof fetch;
    await expect(
      callJudgeModel({ ...baseReq, config: anthropicCfg, fetchImpl: fn }),
    ).rejects.toMatchObject({ reason: expect.stringMatching(/timed out/) });
  });

  it('rejects an empty completion', async () => {
    const { fn } = fakeFetch({ jsonBody: { content: [{ type: 'text', text: '' }] } });
    await expect(
      callJudgeModel({ ...baseReq, config: anthropicCfg, fetchImpl: fn }),
    ).rejects.toMatchObject({ reason: expect.stringMatching(/empty completion/) });
  });
});

it('does not forward a judge key or screenshots across a real 307 redirect', async () => {
  let received = 0;
  const sink = createServer((_req, res) => {
    received++;
    res.end('{}');
  });
  await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve));
  const redirect = createServer((req, res) => {
    expect(req.headers['x-api-key']).toBe(baseReq.apiKey);
    req.resume();
    res
      .writeHead(307, {
        location: `http://127.0.0.1:${(sink.address() as AddressInfo).port}/stolen`,
      })
      .end();
  });
  await new Promise<void>((resolve) => redirect.listen(0, '127.0.0.1', resolve));
  try {
    await expect(
      callJudgeModel({
        ...baseReq,
        config: {
          ...anthropicCfg,
          baseUrl: `http://127.0.0.1:${(redirect.address() as AddressInfo).port}`,
        },
      }),
    ).rejects.toThrow('network error');
    expect(received).toBe(0);
  } finally {
    await Promise.all(
      [sink, redirect].map(
        (server) => new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
  }
});

it('rejects insecure non-loopback judge endpoints before fetch', async () => {
  const { fn, calls } = fakeFetch({ jsonBody: { content: [{ type: 'text', text: 'ok' }] } });
  for (const baseUrl of [
    'http://provider.example',
    'http://127.0.0.1.evil.example',
    'ftp://localhost',
    'not a URL',
  ]) {
    await expect(
      callJudgeModel({ ...baseReq, config: { ...anthropicCfg, baseUrl }, fetchImpl: fn }),
    ).rejects.toThrow(/endpoint/);
  }
  expect(calls).toHaveLength(0);
  for (const baseUrl of [
    'http://localhost:1234',
    'http://127.0.0.1:1234',
    'http://[::1]:1234',
    'https://provider.example',
  ]) {
    await expect(
      callJudgeModel({ ...baseReq, config: { ...anthropicCfg, baseUrl }, fetchImpl: fn }),
    ).resolves.toEqual({ raw: 'ok' });
  }
});
