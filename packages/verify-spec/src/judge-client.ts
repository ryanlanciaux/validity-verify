/**
 * Provider-agnostic LLM judge client — a THIN fetch wrapper, no SDK.
 *
 * `validity judge` sends the blind judge-pack (rubric text + screenshots) to a
 * user-configured model and gets back scores matching `scores.schema.json`.
 * This module owns two concerns and nothing else:
 *
 *   callJudgeModel      — one multimodal request to the configured provider
 *                         (Anthropic Messages, OpenAI Chat Completions, or any
 *                         OpenAI-compatible endpoint), returning the raw text.
 *   validateJudgeReply  — validate that raw text against `scores.schema.json`,
 *                         returning either the typed reply or precise errors to
 *                         feed back on the single retry.
 *
 * HARD PRODUCT RULE (enforced by construction): the API key is passed in by the
 * caller (read from the environment at call time) and used ONLY to authenticate
 * the request to the user's chosen provider. Nothing here ever touches a
 * Validity endpoint, writes the key to disk, or logs it.
 *
 * No new runtime dependency: uses the global `fetch` (Node 18+). A `fetchImpl`
 * override exists solely so tests can assert the wire shape without a network.
 */
import type { JudgeModelConfig } from './types.js';

/** A screenshot to attach to the judge request. `base64` is the raw PNG, no data: prefix. */
export interface JudgeScreenshot {
  screenshotId: string;
  label: string;
  base64: string;
}

export interface JudgeCallRequest {
  config: JudgeModelConfig;
  /** API key, already read from the environment by the caller. Never persisted here. */
  apiKey: string;
  /** System instructions (blind-judging rules). */
  system: string;
  /** User text — the rubric + output-contract instructions (e.g. SCORING.md + the schema). */
  userText: string;
  /** Screenshots to attach; each is labeled with its screenshotId before the image. */
  screenshots: JudgeScreenshot[];
  /** Max output tokens. Default 4096 (enough for a scores JSON on a large rubric). */
  maxTokens?: number;
  /** Abort the request after this many ms. Default 120_000. */
  timeoutMs?: number;
  /** Injectable fetch (tests). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface JudgeCallResult {
  /** Raw assistant text — expected to be JSON matching scores.schema.json. */
  raw: string;
}

/**
 * A judge-call failure with a one-line, key-free `reason` suitable for the
 * "skipped (needs …)" surfaces. NEVER contains the API key.
 */
export class JudgeClientError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = 'JudgeClientError';
    this.reason = reason;
  }
}

/** The default env var a provider reads its API key from when `apiKeyEnv` is unset. */
export function defaultApiKeyEnv(config: JudgeModelConfig): string {
  return config.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
}

/** The env var name this config's key is read from (explicit `apiKeyEnv` or the provider default). */
export function judgeApiKeyEnv(config: JudgeModelConfig): string {
  return config.apiKeyEnv ?? defaultApiKeyEnv(config);
}

/**
 * Read the judge API key from the environment at call time. Returns undefined
 * (never throws) when the var is missing/blank so callers can degrade to an
 * explicit skipped-with-reason rather than a crash. The key is never persisted.
 */
export function readJudgeApiKey(
  config: JudgeModelConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = env[judgeApiKeyEnv(config)];
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/** A validated judge score entry (mirrors one item of scores.schema.json). */
export interface JudgeReplyScore {
  id: string;
  status: 'pass' | 'fail' | 'unverifiable';
  reasoning: string;
  score?: number;
  screenshotIds: string[];
}

export interface JudgeReply {
  scores: JudgeReplyScore[];
  scoredBy: string;
}

/** Strip a leading ```json / ``` fence and trailing fence, if present. */
function stripCodeFence(text: string): string {
  const t = text.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(t);
  return fence ? fence[1]!.trim() : t;
}

/**
 * Best-effort extraction of the first balanced top-level JSON object from a
 * string that may carry surrounding prose. Returns null when no `{…}` balances.
 */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

const VALID_STATUS = new Set(['pass', 'fail', 'unverifiable']);

/**
 * Validate a raw model reply against `scores.schema.json` (draft-07 subset the
 * pack pins). Returns the typed reply, or a list of precise, human-readable
 * errors to feed back verbatim on the single retry. Tolerant of a markdown
 * code fence or surrounding prose around the JSON object; the SHAPE, not the
 * framing, is what's checked.
 */
export function validateJudgeReply(
  raw: string,
): { ok: true; value: JudgeReply } | { ok: false; errors: string[] } {
  let parsed: unknown;
  const candidate = stripCodeFence(raw);
  try {
    parsed = JSON.parse(candidate);
  } catch {
    const extracted = extractFirstJsonObject(candidate);
    if (extracted == null) {
      return {
        ok: false,
        errors: ['response was not valid JSON and no JSON object could be found'],
      };
    }
    try {
      parsed = JSON.parse(extracted);
    } catch (err) {
      return { ok: false, errors: [`response was not valid JSON: ${(err as Error).message}`] };
    }
  }

  const errors: string[] = [];
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      errors: ['top-level value must be a JSON object with `scores` and `scoredBy`'],
    };
  }
  const obj = parsed as Record<string, unknown>;

  if (typeof obj.scoredBy !== 'string' || obj.scoredBy.trim().length === 0) {
    errors.push(
      '`scoredBy` is required and must be a non-empty string (your model/agent identity)',
    );
  }
  if (!Array.isArray(obj.scores)) {
    errors.push('`scores` is required and must be an array');
  } else if (obj.scores.length === 0) {
    errors.push('`scores` must contain at least one entry');
  } else {
    obj.scores.forEach((entry, i) => {
      const where = `scores[${i}]`;
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        errors.push(`${where}: must be an object`);
        return;
      }
      const s = entry as Record<string, unknown>;
      if (typeof s.id !== 'string' || s.id.trim().length === 0) {
        errors.push(`${where}.id: required string (a criterion id from rubric.json)`);
      }
      if (typeof s.status !== 'string' || !VALID_STATUS.has(s.status)) {
        errors.push(
          `${where}.status: must be one of pass|fail|unverifiable (got ${JSON.stringify(s.status)})`,
        );
      }
      if (typeof s.reasoning !== 'string' || s.reasoning.trim().length === 0) {
        errors.push(`${where}.reasoning: required non-empty string quoting what you saw`);
      }
      if (
        !Array.isArray(s.screenshotIds) ||
        s.screenshotIds.length === 0 ||
        !s.screenshotIds.every((x) => typeof x === 'string')
      ) {
        errors.push(
          `${where}.screenshotIds: required non-empty array of screenshotId strings from rubric.json`,
        );
      }
      if (s.score !== undefined) {
        if (typeof s.score !== 'number' || Number.isNaN(s.score) || s.score < 0 || s.score > 1) {
          errors.push(`${where}.score: when present, must be a number in [0,1]`);
        }
      }
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: obj as unknown as JudgeReply };
}

/** Normalize a base URL by trimming a single trailing slash. */
function trimBase(url: string): string {
  return url.replace(/\/+$/, '');
}

interface WireRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Build the Anthropic Messages API request (multimodal). */
function anthropicRequest(req: JudgeCallRequest): WireRequest {
  const base = trimBase(req.config.baseUrl ?? 'https://api.anthropic.com');
  const content: unknown[] = [{ type: 'text', text: req.userText }];
  for (const shot of req.screenshots) {
    content.push({ type: 'text', text: `[screenshotId: ${shot.screenshotId}] ${shot.label}` });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: shot.base64 },
    });
  }
  return {
    url: `${base}/v1/messages`,
    headers: {
      'content-type': 'application/json',
      'x-api-key': req.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: {
      model: req.config.model,
      max_tokens: req.maxTokens ?? 4096,
      system: req.system,
      messages: [{ role: 'user', content }],
    },
  };
}

/** Build the OpenAI (or OpenAI-compatible) Chat Completions request (multimodal). */
function openaiRequest(req: JudgeCallRequest): WireRequest {
  const base = trimBase(req.config.baseUrl ?? 'https://api.openai.com/v1');
  const content: unknown[] = [{ type: 'text', text: req.userText }];
  for (const shot of req.screenshots) {
    content.push({ type: 'text', text: `[screenshotId: ${shot.screenshotId}] ${shot.label}` });
    content.push({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${shot.base64}` },
    });
  }
  return {
    url: `${base}/chat/completions`,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${req.apiKey}`,
    },
    body: {
      model: req.config.model,
      max_tokens: req.maxTokens ?? 4096,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content },
      ],
    },
  };
}

/** Pull the assistant text out of an Anthropic Messages response. */
function anthropicText(json: unknown): string {
  const blocks = (json as { content?: Array<{ type?: string; text?: string }> })?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

/** Pull the assistant text out of an OpenAI Chat Completions response. */
function openaiText(json: unknown): string {
  const choice = (json as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === 'string') return content;
  // Some OpenAI-compatible servers return an array of content parts.
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : ((p as { text?: string })?.text ?? '')))
      .join('');
  }
  return '';
}

/**
 * Send one multimodal judge request to the configured provider and return the
 * raw assistant text. Throws {@link JudgeClientError} (key-free reason) on a
 * non-2xx status, a network failure, a timeout, or an empty completion — the
 * caller turns any of these into an explicit skipped-with-reason (never a pass).
 */
export async function callJudgeModel(req: JudgeCallRequest): Promise<JudgeCallResult> {
  const doFetch = req.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new JudgeClientError(
      'no fetch implementation available (Node 18+ required for the judge)',
    );
  }
  const wire = req.config.provider === 'anthropic' ? anthropicRequest(req) : openaiRequest(req);

  let endpoint: URL;
  try {
    endpoint = new URL(wire.url);
  } catch {
    throw new JudgeClientError('invalid judge endpoint');
  }
  if (
    endpoint.protocol !== 'https:' &&
    !(
      endpoint.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
    )
  ) {
    throw new JudgeClientError('judge endpoint requires HTTPS (except loopback development HTTP)');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), req.timeoutMs ?? 120_000);
  let res: Response;
  try {
    res = await doFetch(wire.url, {
      method: 'POST',
      redirect: 'error',
      headers: wire.headers,
      body: JSON.stringify(wire.body),
      signal: controller.signal,
    });
  } catch (err) {
    const e = err as Error;
    // Transport errors can echo request headers or credentials in the URL.
    const why = e?.name === 'AbortError' ? 'request timed out' : 'network error';
    throw new JudgeClientError(`${req.config.provider} request failed: ${why}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    // Untrusted error bodies may echo even partial credentials. Keep only the status.
    throw new JudgeClientError(`${req.config.provider} returned HTTP ${res.status}`);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    // JSON parse errors can include excerpts from the untrusted response body.
    throw new JudgeClientError(`${req.config.provider} response was not JSON`);
  }
  const raw = req.config.provider === 'anthropic' ? anthropicText(json) : openaiText(json);
  if (!raw.trim()) {
    throw new JudgeClientError(`${req.config.provider} returned an empty completion`);
  }
  return { raw };
}
