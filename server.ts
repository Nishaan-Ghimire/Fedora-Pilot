import 'dotenv/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ThinkingLevel, Type, type Content, type Part } from '@google/genai';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer as createViteServer } from 'vite';
import { WebSocketServer } from 'ws';
import { MODEL_CONFIG } from './server/config/models.ts';
import {
  getGeminiBetaClient,
  getGeminiClient,
  getGeminiSettings,
  getStatusCode,
  recordGeminiUsage,
  trackGeminiStream,
  updateGeminiApiKey,
  withModelFallback,
} from './server/services/gemini.ts';
import {
  extractTextFromUpload,
  getAllKnowledgeText,
  ingestKnowledge,
  searchKnowledge,
} from './server/services/kb.ts';
import { attachLiveWebSocketServer } from './server/services/live.ts';
import {
  buildAgentSystemInstruction,
  VOICE_TOOL_DECLARATIONS,
} from './server/services/prompts.ts';
import {
  getStore,
  resetSeedKnowledgeForAssistant,
  saveStore,
} from './server/services/store.ts';
import type {
  Appointment,
  Assistant,
  CallLog,
  SearchChunkResult,
} from './src/types.ts';

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

// Simple sliding-window rate limiter per IP
function createRateLimiter(maxRequests: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((ts) => now - ts < windowMs);
    if (recent.length >= maxRequests) {
      res.status(429).json({
        error: 'Rate limit exceeded. Please pause briefly and try again.',
      });
      return;
    }
    recent.push(now);
    hits.set(key, recent);
    next();
  };
}

function sendErrorResponse(res: Response, err: unknown, fallbackMsg: string): void {
  const status = getStatusCode(err);
  const message = err instanceof Error ? err.message : fallbackMsg;
  if (status === 403 || status === 400) {
    res.status(status).json({ error: `${message} Check the Gemini API key in Settings.` });
    return;
  }
  if (status === 429) {
    res.status(429).json({ error: `Gemini quota rate limit hit (429). You can change the API key in Settings. ${message}` });
    return;
  }
  res.status(status && status >= 400 && status < 600 ? status : 500).json({ error: message });
}

async function startServer() {
  // Initialize seed store at boot
  getStore();

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));

  const aiRateLimit = createRateLimiter(90, 60_000);
  const crudRateLimit = createRateLimiter(300, 60_000);
  const settingsRateLimit = createRateLimiter(10, 60_000);
  const settingsPassword = process.env.DASHBOARD_SETTINGS_PASSWORD;
  const passwordDigest = (password: string) => createHash('sha256').update(password).digest();
  const settingsPasswordDigest = settingsPassword?.trim() ? passwordDigest(settingsPassword) : undefined;
  const settingsStatus = () => ({
    ...getGeminiSettings(),
    canManageApiKey: Boolean(settingsPasswordDigest),
  });

  app.get('/api/settings', crudRateLimit, (_req, res) => {
    res.set('Cache-Control', 'no-store').json(settingsStatus());
  });

  app.put('/api/settings/api-key', settingsRateLimit, (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!settingsPasswordDigest) {
      res.status(503).json({ error: 'Set DASHBOARD_SETTINGS_PASSWORD on the server to enable API key changes.' });
      return;
    }

    const { password, apiKey, resetTokens } = req.body ?? {};
    if (
      typeof password !== 'string' ||
      !timingSafeEqual(passwordDigest(password), settingsPasswordDigest)
    ) {
      res.status(403).json({ error: 'Incorrect settings password.' });
      return;
    }

    const key = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (!key || key.length > 512 || /\s/.test(key) || key === 'MY_GEMINI_API_KEY') {
      res.status(400).json({ error: 'Enter a valid Gemini API key.' });
      return;
    }
    if (typeof resetTokens !== 'boolean') {
      res.status(400).json({ error: 'Choose whether to reset the token count.' });
      return;
    }

    try {
      updateGeminiApiKey(key, resetTokens);
      res.json(settingsStatus());
    } catch {
      res.status(500).json({ error: 'Unable to save the API key on the server.' });
    }
  });

  // Health & configured model info
  app.get('/api/models', crudRateLimit, (_req, res) => {
    res.json({
      ...MODEL_CONFIG,
      hasApiKey: getGeminiSettings().hasApiKey,
    });
  });

  // ---------------- Assistants CRUD ----------------
  app.get('/api/assistants', crudRateLimit, (_req, res) => {
    const store = getStore();
    res.json({ assistants: store.assistants });
  });

  app.post('/api/assistants', crudRateLimit, (req, res) => {
    const body = (req.body ?? {}) as Partial<Assistant>;
    if (!body.name?.trim() || !body.companyName?.trim()) {
      res.status(400).json({ error: 'Assistant name and company name are required.' });
      return;
    }

    const store = getStore();
    const now = new Date().toISOString();

    if (body.id) {
      const existing = store.assistants.find((a) => a.id === body.id);
      if (existing) {
        existing.name = body.name.trim();
        existing.companyName = body.companyName.trim();
        existing.phoneNumber = body.phoneNumber?.trim() || existing.phoneNumber;
        if (typeof body.greetFirst === 'boolean') {
          existing.greetFirst = body.greetFirst;
        }
        existing.firstMessage = body.firstMessage?.trim() ?? existing.firstMessage;
        existing.systemPrompt = body.systemPrompt?.trim() ?? existing.systemPrompt;
        existing.language = body.language?.trim() || existing.language;
        existing.voice = body.voice || existing.voice;
        existing.styleInstruction =
          body.styleInstruction?.trim() ?? existing.styleInstruction;
        existing.temperature =
          typeof body.temperature === 'number'
            ? Math.max(0, Math.min(1, body.temperature))
            : existing.temperature;
        existing.maxSentences =
          typeof body.maxSentences === 'number'
            ? Math.max(1, Math.min(6, Math.round(body.maxSentences)))
            : existing.maxSentences;
        existing.mode = body.mode === 'realtime' ? 'realtime' : 'pipeline';
        existing.stuffAllContext = Boolean(body.stuffAllContext);
        existing.updatedAt = now;
        saveStore();
        res.json({ assistant: existing });
        return;
      }
    }

    const created: Assistant = {
      id: `ast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: body.name.trim(),
      companyName: body.companyName.trim(),
      phoneNumber: body.phoneNumber?.trim() || '+1 (555) 019-2834',
      greetFirst: typeof body.greetFirst === 'boolean' ? body.greetFirst : true,
      firstMessage:
        body.firstMessage?.trim() ||
        `Hello, thank you for calling ${body.companyName.trim()}, this is ${body.name.trim()}. How can I help you today?`,
      systemPrompt:
        body.systemPrompt?.trim() ||
        `You are ${body.name.trim()}, a helpful voice representative for ${body.companyName.trim()}.`,
      language: body.language?.trim() || 'en-US',
      voice: body.voice || 'Kore',
      styleInstruction:
        body.styleInstruction?.trim() ||
        'Speak warmly, clearly, and at a calm, natural pace',
      temperature:
        typeof body.temperature === 'number'
          ? Math.max(0, Math.min(1, body.temperature))
          : 0.3,
      maxSentences:
        typeof body.maxSentences === 'number'
          ? Math.max(1, Math.min(6, Math.round(body.maxSentences)))
          : 2,
      mode: body.mode === 'realtime' ? 'realtime' : 'pipeline',
      stuffAllContext: Boolean(body.stuffAllContext),
      createdAt: now,
      updatedAt: now,
    };

    store.assistants.push(created);
    saveStore();
    res.status(201).json({ assistant: created });
  });

  app.delete('/api/assistants/:id', crudRateLimit, (req, res) => {
    const store = getStore();
    if (store.assistants.length <= 1) {
      res.status(400).json({ error: 'At least one assistant must remain available.' });
      return;
    }
    const idx = store.assistants.findIndex((a) => a.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: 'Assistant not found.' });
      return;
    }
    store.assistants.splice(idx, 1);
    store.documents = store.documents.filter((d) => d.assistantId !== req.params.id);
    store.chunks = store.chunks.filter((c) => c.assistantId !== req.params.id);
    saveStore();
    res.json({ ok: true });
  });

  // ---------------- Knowledge Base ----------------
  app.get('/api/kb', crudRateLimit, (req, res) => {
    const assistantId = String(req.query.assistantId || '');
    const store = getStore();
    const docs = assistantId
      ? store.documents.filter((d) => d.assistantId === assistantId)
      : store.documents;
    const chunks = assistantId
      ? store.chunks.filter((c) => c.assistantId === assistantId)
      : store.chunks;

    const totalTokens = chunks.reduce((sum, c) => sum + c.tokenEstimate, 0);
    const embeddedCount = chunks.filter((c) => c.embedding && c.embedding.length > 0).length;

    res.json({
      documents: docs,
      chunks: chunks.map(({ embedding: _emb, ...rest }) => rest),
      totalTokens,
      embeddedCount,
      chunkCount: chunks.length,
    });
  });

  app.delete('/api/kb/doc/:docId', crudRateLimit, (req, res) => {
    const store = getStore();
    store.documents = store.documents.filter((d) => d.id !== req.params.docId);
    store.chunks = store.chunks.filter((c) => c.docId !== req.params.docId);
    saveStore();
    res.json({ ok: true });
  });

  app.post('/api/kb/reset-seed', crudRateLimit, (req, res) => {
    const assistantId = String(req.body?.assistantId || 'anita-himalayan-dental-np');
    resetSeedKnowledgeForAssistant(assistantId);
    res.json({ ok: true });
  });

  app.post('/api/kb/ingest', aiRateLimit, async (req, res) => {
    try {
      const { assistantId, source, sourceType, text, filename, contentBase64, faqs } =
        (req.body ?? {}) as {
          assistantId?: string;
          source?: string;
          sourceType?: 'text' | 'file' | 'faq';
          text?: string;
          filename?: string;
          contentBase64?: string;
          faqs?: Array<{ q: string; a: string }>;
        };

      if (!assistantId) {
        res.status(400).json({ error: 'assistantId is required.' });
        return;
      }

      let resolvedText = '';
      let resolvedSource = source || 'Manual Entry';
      let resolvedType: 'text' | 'file' | 'faq' = sourceType || 'text';

      if (Array.isArray(faqs) && faqs.length > 0) {
        resolvedType = 'faq';
        resolvedSource = source || 'FAQ Pairs';
        resolvedText = faqs
          .filter((f) => f.q?.trim() && f.a?.trim())
          .map((f) => `Q: ${f.q.trim()}\nA: ${f.a.trim()}`)
          .join('\n\n');
      } else if (filename) {
        const ext = filename.split('.').pop()?.toLowerCase() ?? '';
        if (!['txt', 'md', 'csv', 'pdf'].includes(ext)) {
          res.status(400).json({ error: 'Only .txt, .md, .csv, and .pdf files are supported.' });
          return;
        }
        resolvedType = 'file';
        resolvedSource = source || filename;
        resolvedText = await extractTextFromUpload({
          filename,
          contentBase64,
          textContent: text,
        });
      } else {
        resolvedText = text ?? '';
      }

      if (!resolvedText.trim()) {
        res.status(400).json({ error: 'No extractable text found to ingest.' });
        return;
      }

      const result = await ingestKnowledge({
        assistantId,
        source: resolvedSource,
        sourceType: resolvedType,
        text: resolvedText,
      });

      res.status(201).json({
        document: result.document,
        chunkCount: result.chunks.length,
      });
    } catch (err) {
      sendErrorResponse(res, err, 'Failed to ingest knowledge.');
    }
  });

  app.post('/api/kb/search', aiRateLimit, async (req, res) => {
    try {
      const { assistantId, query, topK } = (req.body ?? {}) as {
        assistantId?: string;
        query?: string;
        topK?: number;
      };
      if (!assistantId || !query?.trim()) {
        res.status(400).json({ error: 'assistantId and query are required.' });
        return;
      }

      const searchRes = await searchKnowledge({
        assistantId,
        query: query.trim(),
        topK: typeof topK === 'number' ? topK : 4,
      });
      res.json(searchRes);
    } catch (err) {
      sendErrorResponse(res, err, 'Knowledge search failed.');
    }
  });

  // ---------------- Pipeline LLM Chat (SSE Streaming) ----------------
  app.post('/api/chat', aiRateLimit, async (req, res) => {
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) {
        controller.abort();
      }
    });

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const writeEvent = (event: string, data: unknown) => {
      if (res.writableEnded || controller.signal.aborted) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const { assistantId, message, previousTurnContext, history } = (req.body ?? {}) as {
        assistantId?: string;
        message?: string;
        previousTurnContext?: string;
        history?: Array<{ role: 'user' | 'agent'; text: string }>;
      };

      if (!assistantId || !message?.trim()) {
        writeEvent('error', { message: 'assistantId and message are required.' });
        res.end();
        return;
      }

      const store = getStore();
      const assistant =
        store.assistants.find((a) => a.id === assistantId) ?? store.assistants[0];
      if (!assistant) {
        writeEvent('error', { message: 'Assistant not found.' });
        res.end();
        return;
      }

      // Step 1: Retrieve context (RAG top-4 vs full KB stuff < 30k tokens)
      const allKb = getAllKnowledgeText(assistant.id);
      let chunksUsed: SearchChunkResult[] = [];
      let retrievalMs = 0;
      let contextStrategy: 'rag' | 'stuffed' = 'rag';
      let knowledgeBlock = '';

      if (assistant.stuffAllContext && allKb.totalTokens > 0 && allKb.totalTokens < 30_000) {
        const startStuff = performance.now();
        contextStrategy = 'stuffed';
        knowledgeBlock = allKb.text;
        chunksUsed = allKb.chunks;
        retrievalMs = Math.max(1, Math.round(performance.now() - startStuff));
      } else {
        const retrievalQuery = previousTurnContext?.trim()
          ? `${previousTurnContext.trim()}\nCaller: ${message.trim()}`
          : message.trim();
        const searchRes = await searchKnowledge({
          assistantId: assistant.id,
          query: retrievalQuery,
          topK: 4,
        });
        chunksUsed = searchRes.results;
        retrievalMs = searchRes.retrievalMs;
        knowledgeBlock = chunksUsed
          .map(
            (c, idx) =>
              `[Chunk ${idx + 1} | Source: ${c.source} | Similarity: ${c.similarity.toFixed(3)}]\n${c.text}`
          )
          .join('\n\n');
      }

      writeEvent('meta', {
        retrievalMs,
        chunksUsed,
        contextStrategy,
      });

      const systemInstruction = buildAgentSystemInstruction(assistant, knowledgeBlock);
      const recentHistory = Array.isArray(history) ? history.slice(-10) : [];
      const contents: Content[] = [
        ...recentHistory.map((turn) => ({
          role: turn.role === 'agent' ? 'model' : 'user',
          parts: [{ text: turn.text }],
        })),
        {
          role: 'user',
          parts: [{ text: message.trim() }],
        },
      ];

      const ai = getGeminiClient();
      const llmStart = performance.now();
      let ttftMs: number | null = null;
      let fullText = '';

      const runStreamTurn = async (turnContents: Content[]) => {
        const candidates = [
          MODEL_CONFIG.LLM_MODEL,
          ...MODEL_CONFIG.LLM_FALLBACK_MODELS,
        ].filter((m, idx, arr) => Boolean(m) && arr.indexOf(m) === idx);

        let lastTurnErr: unknown = null;
        const attemptErrors: string[] = [];

        for (let idx = 0; idx < candidates.length; idx++) {
          const model = candidates[idx];
          if (controller.signal.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }

          const attemptController = new AbortController();
          const forwardAbort = () => attemptController.abort();
          controller.signal.addEventListener('abort', forwardAbort, { once: true });

          // Guard against stalled streams before first token/tool arrives
          let receivedFirstChunk = false;
          const firstChunkTimer = setTimeout(() => {
            if (!receivedFirstChunk) {
              attemptController.abort();
            }
          }, 8000);

          try {
            const isGemini4 = model.startsWith('gemini-4');
            const stream = await ai.models.generateContentStream({
              model,
              contents: turnContents,
              config: {
                abortSignal: attemptController.signal,
                systemInstruction,
                tools: [{ functionDeclarations: VOICE_TOOL_DECLARATIONS }],
                ...(isGemini4
                  ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
                  : { temperature: assistant.temperature }),
              },
            });

            const pendingCalls: Array<{
              id?: string;
              name?: string;
              args?: Record<string, unknown>;
            }> = [];
            const modelParts: Part[] = [];

            for await (const chunk of trackGeminiStream(ai, stream)) {
              if (!receivedFirstChunk) {
                receivedFirstChunk = true;
                clearTimeout(firstChunkTimer);
              }
              if (controller.signal.aborted) break;

              const parts = chunk.candidates?.[0]?.content?.parts ?? [];
              for (const p of parts) {
                modelParts.push(p);
              }

              if (chunk.functionCalls && chunk.functionCalls.length > 0) {
                for (const fc of chunk.functionCalls) {
                  pendingCalls.push({
                    id: fc.id,
                    name: fc.name,
                    args: (fc.args ?? {}) as Record<string, unknown>,
                  });
                }
              }

              const delta = chunk.text;
              if (delta) {
                if (ttftMs === null) {
                  ttftMs = Math.max(1, Math.round(performance.now() - llmStart));
                }
                fullText += delta;
                writeEvent('token', { text: delta, ttftMs, modelUsed: model });
              }
            }

            clearTimeout(firstChunkTimer);
            controller.signal.removeEventListener('abort', forwardAbort);
            return { pendingCalls, modelParts, modelUsed: model };
          } catch (err) {
            clearTimeout(firstChunkTimer);
            controller.signal.removeEventListener('abort', forwardAbort);
            if (controller.signal.aborted) {
              throw err;
            }
            const errDesc =
              err instanceof Error ? `${err.name}: ${err.message}` : String(err);
            attemptErrors.push(`${model} -> ${errDesc}`);
            lastTurnErr = err;
            const hasMore = idx < candidates.length - 1;
            if (hasMore && !receivedFirstChunk) {
              console.warn(`LLM stream attempt failed/stalled on ${model}, falling back:`, errDesc);
              continue;
            }
            throw new Error(`LLM failed (${attemptErrors.join(' | ')})`);
          }
        }

        throw lastTurnErr ?? new Error(`All LLM models failed (${attemptErrors.join(' | ')})`);
      };

      const firstPass = await runStreamTurn(contents);

      if (firstPass.pendingCalls.length > 0 && !controller.signal.aborted) {
        const responseParts: Part[] = [];
        let shouldEndCall = false;

        for (const call of firstPass.pendingCalls) {
          const args = call.args ?? {};
          let toolResult: Record<string, unknown> = { ok: true };

          if (call.name === 'book_appointment') {
            const appt: Appointment = {
              id: `appt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              assistantId: assistant.id,
              name: String(args.name ?? 'Caller'),
              phone: String(args.phone ?? 'Not provided'),
              datetime: String(args.datetime ?? 'Requested slot'),
              createdAt: new Date().toISOString(),
            };
            store.appointments.unshift(appt);
            saveStore();
            toolResult = { status: 'confirmed', appointment: appt };
          } else if (call.name === 'transfer_to_human') {
            toolResult = {
              status: 'transferring',
              department: String(args.department ?? 'Front Desk'),
            };
          } else if (call.name === 'end_call') {
            shouldEndCall = true;
            toolResult = {
              status: 'ending_call',
              reason: String(args.reason ?? 'Caller finished'),
            };
          }

          writeEvent('tool', {
            name: call.name,
            args,
            result: toolResult,
          });

          responseParts.push({
            functionResponse: {
              id: call.id,
              name: call.name,
              response: toolResult,
            },
          });
        }

        // Follow-up stream so the model speaks confirmation of the tool execution
        const followUpContents: Content[] = [
          ...contents,
          { role: 'model', parts: firstPass.modelParts },
          { role: 'user', parts: responseParts },
        ];
        await runStreamTurn(followUpContents);

        if (shouldEndCall) {
          writeEvent('end_call', { reason: 'Agent invoked end_call' });
        }
      }

      writeEvent('done', {
        fullText: fullText.trim(),
        ttftMs: ttftMs ?? Math.max(1, Math.round(performance.now() - llmStart)),
        retrievalMs,
      });
      res.end();
    } catch (err) {
      if (controller.signal.aborted) {
        res.end();
        return;
      }
      const status = getStatusCode(err);
      const message = err instanceof Error ? err.message : 'Chat stream failed.';
      writeEvent('error', { message, status });
      res.end();
    }
  });

  // ---------------- Text-to-Speech (24kHz 16-bit mono RAW PCM) ----------------
  app.post('/api/tts', aiRateLimit, async (req, res) => {
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) {
        controller.abort();
      }
    });

    try {
      const { text, voiceName, styleInstruction } = (req.body ?? {}) as {
        text?: string;
        voiceName?: string;
        styleInstruction?: string;
      };

      const cleanText = text?.trim();
      if (!cleanText) {
        res.status(400).json({ error: 'text is required.' });
        return;
      }

      const ai = getGeminiBetaClient();
      const ttsStart = performance.now();
      let ttfaMs: number | null = null;

      const { result: pcmBuffer, modelUsed } = await withModelFallback(
        MODEL_CONFIG.TTS_MODEL,
        MODEL_CONFIG.TTS_FALLBACK_MODELS,
        async (model) => {
          const is38 = model.includes('3.8');
          const styledText =
            !is38 && styleInstruction?.trim()
              ? `${styleInstruction.trim()}: ${cleanText}`
              : cleanText;

          const partPayload =
            is38 && styleInstruction?.trim()
              ? {
                  text: cleanText,
                  speechMetadata: { style: styleInstruction.trim() },
                }
              : { text: styledText };

          const stream = await ai.models.generateContentStream({
            model,
            contents: [{ role: 'user', parts: [partPayload] }],
            config: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: voiceName || 'Kore',
                  },
                },
              },
            },
          });

          const chunks: Buffer[] = [];
          for await (const chunk of trackGeminiStream(ai, stream)) {
            if (controller.signal.aborted) {
              throw new DOMException('Aborted', 'AbortError');
            }
            const inlineData = chunk.candidates?.[0]?.content?.parts?.[0]?.inlineData;
            if (inlineData?.data) {
              if (ttfaMs === null) {
                ttfaMs = Math.max(1, Math.round(performance.now() - ttsStart));
              }
              chunks.push(Buffer.from(inlineData.data, 'base64'));
            }
          }

          let combined = Buffer.concat(chunks);
          // Safety strip 44-byte RIFF/WAV header if any model variant returns WAV instead of headerless L16 PCM
          if (
            combined.length > 44 &&
            combined.subarray(0, 4).toString('ascii') === 'RIFF'
          ) {
            combined = combined.subarray(44);
          }

          if (combined.length === 0) {
            throw new Error('TTS model returned empty audio stream.');
          }
          return combined;
        },
        { signal: controller.signal }
      );

      res.json({
        audio: pcmBuffer.toString('base64'),
        sampleRate: 24000,
        channels: 1,
        bitDepth: 16,
        format: 'pcm_s16le',
        ttfaMs: ttfaMs ?? Math.max(1, Math.round(performance.now() - ttsStart)),
        modelUsed,
      });
    } catch (err) {
      if ((err as Error)?.name === 'AbortError' || controller.signal.aborted) {
        if (!res.writableEnded) res.end();
        return;
      }
      sendErrorResponse(res, err, 'TTS synthesis failed.');
    }
  });

  // ---------------- STT Audio Transcription Fallback ----------------
  app.post('/api/stt', aiRateLimit, async (req, res) => {
    try {
      const { audioBase64, mimeType, language } = (req.body ?? {}) as {
        audioBase64?: string;
        mimeType?: string;
        language?: string;
      };
      if (!audioBase64) {
        res.status(400).json({ error: 'audioBase64 is required.' });
        return;
      }

      const isNepali = (language || '').toLowerCase().startsWith('ne');
      const sttInstruction = isNepali
        ? 'Transcribe the spoken speech accurately in Nepali using Devanagari script (नेपाली). If the speaker mixes English words or Romanized terms, transcribe naturally in Devanagari नेपाली while keeping names and numbers clear. Return ONLY the spoken words with no commentary or quotes. If there is only silence or background noise, return an empty string.'
        : `Transcribe the spoken speech accurately in ${language || 'en-US'}. Return ONLY the spoken words with no commentary or quotes. If there is only silence or background noise, return an empty string.`;

      const ai = getGeminiClient();
      const { result } = await withModelFallback(
        MODEL_CONFIG.TRANSCRIBE_MODEL,
        MODEL_CONFIG.TRANSCRIBE_FALLBACK_MODELS,
        async (model) => {
          return ai.models.generateContent({
            model,
            contents: {
              parts: [
                {
                  inlineData: {
                    mimeType: mimeType || 'audio/webm',
                    data: audioBase64,
                  },
                },
                {
                  text: sttInstruction,
                },
              ],
            },
          });
        }
      );

      recordGeminiUsage(ai, result.usageMetadata?.totalTokenCount);
      res.json({ text: (result.text ?? '').trim() });
    } catch (err) {
      sendErrorResponse(res, err, 'Audio transcription failed.');
    }
  });

  // ---------------- Appointments ----------------
  app.get('/api/appointments', crudRateLimit, (_req, res) => {
    const store = getStore();
    res.json({ appointments: store.appointments });
  });

  // ---------------- Call Logs + Post-Call Summary ----------------
  app.get('/api/calls', crudRateLimit, (_req, res) => {
    const store = getStore();
    res.json({ calls: store.calls });
  });

  app.post('/api/calls', crudRateLimit, async (req, res) => {
    try {
      const body = (req.body ?? {}) as Partial<CallLog>;
      const transcript = Array.isArray(body.transcript) ? body.transcript : [];
      const spokenTranscript = transcript
        .filter((t) => !t.isInterim && t.role !== 'system' && t.text.trim())
        .map((t) => `${t.role === 'user' ? 'Caller' : 'Agent'}: ${t.text}`)
        .join('\n');

      let summary = 'Call completed with no spoken conversation recorded.';
      let outcome = 'Ended Early';

      if (spokenTranscript.trim().length > 0) {
        try {
          const ai = getGeminiClient();
          const { result } = await withModelFallback(
            MODEL_CONFIG.LLM_MODEL,
            MODEL_CONFIG.LLM_FALLBACK_MODELS,
            async (model) => {
              const isGemini4 = model.startsWith('gemini-4');
              return ai.models.generateContent({
                model,
                contents: `Analyze this phone call transcript (which may be in Nepali/Devanagari or English) and produce a concise 1-2 sentence factual summary in clear English (or matching the call language if appropriate) and a short outcome label.\n\nTranscript:\n${spokenTranscript}`,
                config: {
                  responseMimeType: 'application/json',
                  responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                      summary: {
                        type: Type.STRING,
                        description: '1-2 sentence factual summary of the phone call.',
                      },
                      outcome: {
                        type: Type.STRING,
                        description:
                          'Short outcome label such as Appointment Booked, Inquiry Answered, Transferred to Human, Information Unavailable, or Caller Hung Up.',
                      },
                    },
                    required: ['summary', 'outcome'],
                  },
                  ...(isGemini4
                    ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
                    : {}),
                },
              });
            }
          );

          recordGeminiUsage(ai, result.usageMetadata?.totalTokenCount);
          const parsed = JSON.parse((result.text ?? '{}').trim()) as {
            summary?: string;
            outcome?: string;
          };
          if (parsed.summary) summary = parsed.summary;
          if (parsed.outcome) outcome = parsed.outcome;
        } catch (err) {
          console.warn('Post-call summary generation failed, saving raw log:', err);
          summary = 'Call logged (automated summary unavailable).';
          outcome =
            (body.appointmentsBooked?.length ?? 0) > 0
              ? 'Appointment Booked'
              : (body.transfers?.length ?? 0) > 0
                ? 'Transferred to Human'
                : 'Completed';
        }
      }

      const callRecord: CallLog = {
        id: `call-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        assistantId: body.assistantId || 'anita-himalayan-dental-np',
        assistantName: body.assistantName || 'अनिता (Anita)',
        phoneNumber: body.phoneNumber || '+977 1-555-0199',
        mode: body.mode === 'realtime' ? 'realtime' : 'pipeline',
        durationSec: typeof body.durationSec === 'number' ? body.durationSec : 0,
        startedAt: body.startedAt || new Date().toISOString(),
        endedAt: body.endedAt || new Date().toISOString(),
        transcript,
        turnMetrics: Array.isArray(body.turnMetrics) ? body.turnMetrics : [],
        summary,
        outcome,
        appointmentsBooked: Array.isArray(body.appointmentsBooked)
          ? body.appointmentsBooked
          : [],
        transfers: Array.isArray(body.transfers) ? body.transfers : [],
      };

      const store = getStore();
      store.calls.unshift(callRecord);
      saveStore();

      res.status(201).json({ call: callRecord });
    } catch (err) {
      sendErrorResponse(res, err, 'Failed to save call log.');
    }
  });

  // ---------------- HTTP + WebSocket + Vite ----------------
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  attachLiveWebSocketServer(wss);

  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url || '/', `http://${request.headers.host}`).pathname;
    if (pathname === '/api/live') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  if (!IS_PROD) {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Fedora-Pilot server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start Fedora-Pilot server:', err);
  process.exit(1);
});
