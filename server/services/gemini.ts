import { GoogleGenAI } from '@google/genai';

let cachedClient: GoogleGenAI | null = null;
let cachedBetaClient: GoogleGenAI | null = null;

function requireApiKey(): string {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error('GEMINI_API_KEY is not configured in environment secrets.');
  }
  return apiKey;
}

export function getGeminiClient(): GoogleGenAI {
  const apiKey = requireApiKey();
  if (!cachedClient) {
    cachedClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return cachedClient;
}

export function getGeminiBetaClient(): GoogleGenAI {
  const apiKey = requireApiKey();
  if (!cachedBetaClient) {
    cachedBetaClient = new GoogleGenAI({
      apiKey,
      apiVersion: 'v1beta',
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return cachedBetaClient;
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

export function isRetryableError(err: unknown): boolean {
  const code = getStatusCode(err);
  if (code === 429 || code === 503 || code === 502 || code === 504) return true;
  const msg = String((err as Error)?.message ?? '').toLowerCase();
  return (
    msg.includes('rate limit') ||
    msg.includes('resource_exhausted') ||
    msg.includes('temporarily unavailable') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout')
  );
}

export function isModelNotFoundError(err: unknown): boolean {
  const code = getStatusCode(err);
  if (code === 404) return true;
  const msg = String((err as Error)?.message ?? '').toLowerCase();
  return msg.includes('not found') || msg.includes('not supported') || msg.includes('invalid model');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Retry wrapper with exponential backoff + jitter for 429/503 responses.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; baseDelayMs?: number; signal?: AbortSignal } = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 450;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (options.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if ((err as Error)?.name === 'AbortError' || options.signal?.aborted) {
        throw err;
      }
      if (attempt < maxRetries && isRetryableError(err)) {
        const jitter = Math.floor(Math.random() * 150);
        const delay = baseDelayMs * Math.pow(2, attempt) + jitter;
        await sleep(delay, options.signal);
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

/**
 * Attempts a Gemini operation with the primary model and automatically falls back
 * across fallbackModels when the model returns 404 / unsupported.
 */
export async function withModelFallback<T>(
  primaryModel: string,
  fallbackModels: readonly string[],
  run: (model: string) => Promise<T>,
  options: { signal?: AbortSignal } = {}
): Promise<{ result: T; modelUsed: string }> {
  const candidates = [primaryModel, ...fallbackModels].filter(
    (m, i, arr) => Boolean(m) && arr.indexOf(m) === i
  );
  let lastError: unknown;

  for (let i = 0; i < candidates.length; i++) {
    const model = candidates[i];
    try {
      const result = await withRetry(() => run(model), { signal: options.signal });
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
