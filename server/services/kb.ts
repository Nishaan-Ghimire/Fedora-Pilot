import { PDFParse } from 'pdf-parse';
import { MODEL_CONFIG } from '../config/models.ts';
import type { KnowledgeChunk, KnowledgeDocument, SearchChunkResult } from '../../src/types.ts';
import { getGeminiClient, recordGeminiUsage, withModelFallback } from './gemini.ts';
import { chunkText, estimateTokens, getStore, saveStore } from './store.ts';

export async function extractTextFromUpload(params: {
  filename: string;
  contentBase64?: string;
  textContent?: string;
}): Promise<string> {
  const ext = params.filename.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'pdf') {
    if (!params.contentBase64) {
      throw new Error('Missing PDF content.');
    }
    const cleanBase64 = params.contentBase64.replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(cleanBase64, 'base64');
    if (buffer.length > 6 * 1024 * 1024) {
      throw new Error('PDF file exceeds 6MB limit.');
    }
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return result.text?.trim() ?? '';
    } finally {
      await parser.destroy().catch(() => {});
    }
  }

  if (params.textContent !== undefined) {
    return params.textContent;
  }

  if (params.contentBase64) {
    const cleanBase64 = params.contentBase64.replace(/^data:[^;]+;base64,/, '');
    return Buffer.from(cleanBase64, 'base64').toString('utf8');
  }

  return '';
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const ai = getGeminiClient();

  // Batch up to 32 chunks at a time for reliability
  const vectors: number[][] = [];
  const batchSize = 32;
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const { result } = await withModelFallback(
      MODEL_CONFIG.EMBED_MODEL,
      MODEL_CONFIG.EMBED_FALLBACK_MODELS,
      async (model) => {
        return ai.models.embedContent({
          model,
          contents: batch,
        });
      }
    );
    recordGeminiUsage(ai, result.usageMetadata?.totalTokenCount);
    const embeddings = result.embeddings ?? [];
    for (const emb of embeddings) {
      vectors.push(emb.values ?? []);
    }
  }
  return vectors;
}

export async function ensureEmbeddingsForAssistant(assistantId: string): Promise<void> {
  const store = getStore();
  const missing = store.chunks.filter(
    (c) => c.assistantId === assistantId && (!c.embedding || c.embedding.length === 0)
  );
  if (missing.length === 0) return;

  const vectors = await embedTexts(missing.map((c) => c.text));
  missing.forEach((chunk, idx) => {
    if (vectors[idx] && vectors[idx].length > 0) {
      chunk.embedding = vectors[idx];
    }
  });
  saveStore();
}

export async function ingestKnowledge(params: {
  assistantId: string;
  source: string;
  sourceType: 'text' | 'file' | 'faq';
  text: string;
}): Promise<{ document: KnowledgeDocument; chunks: KnowledgeChunk[] }> {
  const cleanText = params.text.trim();
  if (!cleanText) {
    throw new Error('Cannot ingest empty knowledge text.');
  }

  const store = getStore();
  const docId = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const rawChunks = chunkText(cleanText, 500, 50);
  const vectors = await embedTexts(rawChunks);

  const now = new Date().toISOString();
  const document: KnowledgeDocument = {
    id: docId,
    assistantId: params.assistantId,
    source: params.source.trim() || 'Uploaded Document',
    sourceType: params.sourceType,
    tokenEstimate: estimateTokens(cleanText),
    chunkCount: rawChunks.length,
    createdAt: now,
  };

  const newChunks: KnowledgeChunk[] = rawChunks.map((chunkStr, idx) => ({
    id: `${docId}-chunk-${idx}`,
    docId,
    assistantId: params.assistantId,
    source: document.source,
    chunkIndex: idx,
    text: chunkStr,
    tokenEstimate: estimateTokens(chunkStr),
    embedding: vectors[idx],
  }));

  store.documents.unshift(document);
  store.chunks.push(...newChunks);
  saveStore();

  return { document, chunks: newChunks };
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export async function searchKnowledge(params: {
  assistantId: string;
  query: string;
  topK?: number;
}): Promise<{
  results: SearchChunkResult[];
  retrievalMs: number;
  totalTokens: number;
}> {
  const start = performance.now();
  const store = getStore();
  const assistantChunks = store.chunks.filter((c) => c.assistantId === params.assistantId);
  const totalTokens = assistantChunks.reduce((acc, c) => acc + c.tokenEstimate, 0);

  if (assistantChunks.length === 0) {
    return {
      results: [],
      retrievalMs: Math.round(performance.now() - start),
      totalTokens: 0,
    };
  }

  await ensureEmbeddingsForAssistant(params.assistantId);

  const [queryVector] = await embedTexts([params.query]);
  const topK = Math.max(1, Math.min(12, params.topK ?? 4));

  const scored: SearchChunkResult[] = assistantChunks
    .map((chunk) => ({
      id: chunk.id,
      source: chunk.source,
      chunkIndex: chunk.chunkIndex,
      text: chunk.text,
      tokenEstimate: chunk.tokenEstimate,
      similarity: chunk.embedding ? cosineSimilarity(queryVector, chunk.embedding) : 0,
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK);

  return {
    results: scored,
    retrievalMs: Math.max(1, Math.round(performance.now() - start)),
    totalTokens,
  };
}

export function getAllKnowledgeText(assistantId: string): {
  text: string;
  totalTokens: number;
  chunks: SearchChunkResult[];
} {
  const store = getStore();
  const assistantChunks = store.chunks.filter((c) => c.assistantId === assistantId);
  const totalTokens = assistantChunks.reduce((acc, c) => acc + c.tokenEstimate, 0);
  const text = assistantChunks
    .map((c) => `[Source: ${c.source}]\n${c.text}`)
    .join('\n\n---\n\n');

  const chunks: SearchChunkResult[] = assistantChunks.map((c) => ({
    id: c.id,
    source: c.source,
    chunkIndex: c.chunkIndex,
    text: c.text,
    tokenEstimate: c.tokenEstimate,
    similarity: 1,
  }));

  return { text, totalTokens, chunks };
}
