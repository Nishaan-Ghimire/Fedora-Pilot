import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { GoogleGenAI, type GenerateContentResponse } from '@google/genai';

const keyPath = path.resolve('data', '.env.gemini-key');
let dashboardApiKey: string | undefined;
try {
  dashboardApiKey = fs.readFileSync(keyPath, 'utf8').trim();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
const clients = new Map<string, Map<string | undefined, GoogleGenAI>>();
const clientCredentials = new WeakMap<GoogleGenAI, { key: string; usageEpoch: number }>();
const unavailableUntil = new Map<string, number>();
const KEY_COOLDOWN_MS = 60_000;
const KEY_FAILURE = /API_KEY_(?:INVALID|EXPIRED|REVOKED)|(?:api[ _-]?key|credential).{0,60}(?:invalid|expired|revoked|not valid|blocked)/i;
const TRANSIENT_FAILURE = /rate limit|resource[_ ](?:has been )?exhausted|quota|fetch failed|econnreset|etimedout|websocket error|code (?:1006|1011|1013)\b|unexpected server response: (?:401|402|403|408|429|5\d\d)\b/i;
let usageEpoch = 0;
let totalTokens = 0;

function configuredKeys(): string[] {
  const numberedKeys = Array.from({ length: 5 }, (_, i) =>
    process.env[`GEMINI_API_KEY_${i + 1}`]?.trim()
  );
  return [...new Set([dashboardApiKey, ...numberedKeys, process.env.GEMINI_API_KEY?.trim()])]
    .filter((key): key is string => Boolean(key) && key !== 'MY_GEMINI_API_KEY');
}

export function getGeminiSettings() {
  return { hasApiKey: configuredKeys().length > 0, totalTokens };
}

export function updateGeminiApiKey(apiKey: string, resetTokens: boolean): void {
  if (apiKey !== dashboardApiKey) {
    const temporaryPath = `${keyPath}.${randomUUID()}.tmp`;
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    try {
      fs.writeFileSync(temporaryPath, apiKey, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporaryPath, keyPath);
    } finally {
      fs.rmSync(temporaryPath, { force: true });
    }
    if (dashboardApiKey) {
      clients.delete(dashboardApiKey);
      unavailableUntil.delete(dashboardApiKey);
    }
    dashboardApiKey = apiKey;
    unavailableUntil.delete(apiKey);
  }
  if (resetTokens) {
    totalTokens = 0;
    usageEpoch++;
    clients.clear();
  }
}

export function recordGeminiUsage(client: GoogleGenAI, tokens?: number): void {
  if (clientCredentials.get(client)?.usageEpoch === usageEpoch && tokens && tokens > 0) {
    totalTokens += tokens;
  }
}

export async function* trackGeminiStream(
  client: GoogleGenAI,
  stream: AsyncIterable<GenerateContentResponse>,
) {
  let tokens: number | undefined;
  try {
    for await (const chunk of stream) {
      tokens = chunk.usageMetadata?.totalTokenCount ?? tokens;
      yield chunk;
    }
  } finally {
    recordGeminiUsage(client, tokens);
  }
}

function getClient(key: string, apiVersion?: string): GoogleGenAI {
  let versions = clients.get(key);
  if (!versions) {
    versions = new Map();
    clients.set(key, versions);
  }
  let client = versions.get(apiVersion);
  if (!client) {
    client = new GoogleGenAI({
      apiKey: key,
      apiVersion,
      httpOptions: {
        headers: { 'User-Agent': 'aistudio-build' },
        timeout: 20_000,
        retryOptions: { attempts: 1 },
      },
    });
    versions.set(apiVersion, client);
    clientCredentials.set(client, { key, usageEpoch });
  }
  return client;
}

export function markGeminiClientUnavailable(client: GoogleGenAI, error: unknown): boolean {
  if (!shouldSwitchKey(error)) return false;
  const credentials = clientCredentials.get(client);
  if (credentials && configuredKeys().includes(credentials.key)) {
    unavailableUntil.set(credentials.key, Date.now() + KEY_COOLDOWN_MS);
  }
  return true;
}

type FailoverOptions = {
  signal?: AbortSignal;
  apiVersion?: 'v1beta';
  canRetry?: () => boolean;
};

export async function withGeminiKey<T>(
  run: (client: GoogleGenAI) => Promise<T>,
  { signal, apiVersion, canRetry }: FailoverOptions = {}
): Promise<T> {
  signal?.throwIfAborted();
  const keys = configuredKeys();
  if (keys.length === 0) {
    throw new Error('Set a Gemini API key in Settings or configure GEMINI_API_KEY_1 on the server.');
  }
  let lastError: unknown;
  for (const key of keys) {
    signal?.throwIfAborted();
    if ((unavailableUntil.get(key) ?? 0) > Date.now()) continue;
    const client = getClient(key, apiVersion);
    try {
      return await run(client);
    } catch (error) {
      if (signal?.aborted || !markGeminiClientUnavailable(client, error) || canRetry?.() === false) {
        throw error;
      }
      lastError = error;
    }
  }
  throw lastError ?? Object.assign(
    new Error('Gemini API keys are temporarily unavailable. Try again shortly.'),
    { status: 503 }
  );
}

export function getStatusCode(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const anyErr = err as Record<string, unknown>;
  if (typeof anyErr.status === 'number') return anyErr.status;
  if (typeof anyErr.code === 'number') return anyErr.code;
  const msg = String(anyErr.message ?? '');
  if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) return 429;
  if (msg.includes('503') || msg.includes('UNAVAILABLE')) return 503;
  if (msg.includes('404') || msg.includes('NOT_FOUND')) return 404;
  return undefined;
}

function shouldSwitchKey(error: unknown): boolean {
  const status = getStatusCode(error);
  const name = (error as Error)?.name;
  const message = String((error as Error)?.message ?? '');
  if (status === 400) return KEY_FAILURE.test(message);
  return status === 401 || status === 402 || status === 403 || status === 408 ||
    status === 429 || (status !== undefined && status >= 500 && status <= 599) ||
    name === 'TimeoutError' || name === 'AbortError' ||
    KEY_FAILURE.test(message) || TRANSIENT_FAILURE.test(message);
}

export function isModelNotFoundError(err: unknown): boolean {
  const code = getStatusCode(err);
  if (code === 404) return true;
  const msg = String((err as Error)?.message ?? '').toLowerCase();
  return msg.includes('not found') || msg.includes('not supported') || msg.includes('invalid model');
}

/**
 * Attempts a Gemini operation with the primary model and automatically falls back
 * across fallbackModels when the model returns 404 / unsupported.
 */
export async function withModelFallback<T>(
  primaryModel: string,
  fallbackModels: readonly string[],
  run: (model: string, client: GoogleGenAI) => Promise<T>,
  options: FailoverOptions = {}
): Promise<{ result: T; modelUsed: string }> {
  const candidates = [primaryModel, ...fallbackModels].filter(
    (m, i, arr) => Boolean(m) && arr.indexOf(m) === i
  );
  let lastError: unknown;

  for (let i = 0; i < candidates.length; i++) {
    const model = candidates[i];
    try {
      const result = await withGeminiKey((client) => run(model, client), options);
      return { result, modelUsed: model };
    } catch (err) {
      lastError = err;
      if ((err as Error)?.name === 'AbortError' || options.signal?.aborted) {
        throw err;
      }
      if (i < candidates.length - 1 && isModelNotFoundError(err)) {
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}
