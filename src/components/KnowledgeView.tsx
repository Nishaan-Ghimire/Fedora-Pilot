import { useCallback, useEffect, useState } from 'react';
import {
  FileText,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import { MUNICIPALITY_ASSISTANT_ID, MUNICIPALITY_KNOWLEDGE_ID } from '../municipality';
import type {
  Assistant,
  KnowledgeDocument,
  SearchChunkResult,
} from '../types';

interface KnowledgeViewProps {
  assistant: Assistant;
  onUpdateAssistant: (draft: Partial<Assistant>) => Promise<Assistant | null>;
  onNotify: (type: 'error' | 'success' | 'info', title: string, detail?: string) => void;
}

type IngestTab = 'text' | 'file' | 'faq';

export function KnowledgeView({
  assistant,
  onUpdateAssistant,
  onNotify,
}: KnowledgeViewProps) {
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [totalTokens, setTotalTokens] = useState(0);
  const [chunkCount, setChunkCount] = useState(0);
  const [embeddedCount, setEmbeddedCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  const [ingestTab, setIngestTab] = useState<IngestTab>('text');
  const [sourceTitle, setSourceTitle] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [faqPairs, setFaqPairs] = useState<Array<{ q: string; a: string }>>([
    { q: '', a: '' },
  ]);
  const [isIngesting, setIsIngesting] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [topK, setTopK] = useState(4);
  const [searchResults, setSearchResults] = useState<SearchChunkResult[]>([]);
  const [lastRetrievalMs, setLastRetrievalMs] = useState<number | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  const fetchKb = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`/api/kb?assistantId=${encodeURIComponent(assistant.id)}`);
      const data = (await res.json()) as {
        documents: KnowledgeDocument[];
        totalTokens: number;
        chunkCount: number;
        embeddedCount: number;
      };
      setDocuments(data.documents ?? []);
      setTotalTokens(data.totalTokens ?? 0);
      setChunkCount(data.chunkCount ?? 0);
      setEmbeddedCount(data.embeddedCount ?? 0);
    } catch {
      onNotify('error', 'Failed to load knowledge base');
    } finally {
      setIsLoading(false);
    }
  }, [assistant.id, onNotify]);

  useEffect(() => {
    void fetchKb();
    setSearchResults([]);
    setLastRetrievalMs(null);
  }, [fetchKb]);

  const handleIngestText = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pasteText.trim()) {
      onNotify('error', 'Empty text', 'Paste company documentation before ingesting.');
      return;
    }
    setIsIngesting(true);
    try {
      const res = await fetch('/api/kb/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assistantId: assistant.id,
          source: sourceTitle.trim() || 'Pasted Company Notes',
          sourceType: 'text',
          text: pasteText.trim(),
        }),
      });
      const data = (await res.json()) as {
        document?: KnowledgeDocument;
        chunkCount?: number;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || 'Ingestion failed');
      onNotify(
        'success',
        'Knowledge ingested & embedded',
        `${data.chunkCount ?? 0} chunks indexed for ${assistant.name}.`
      );
      setSourceTitle('');
      setPasteText('');
      await fetchKb();
    } catch (err) {
      onNotify(
        'error',
        'Ingestion failed',
        err instanceof Error ? err.message : 'Unable to process knowledge.'
      );
    } finally {
      setIsIngesting(false);
    }
  };

  const handleFileUpload = async (file: File | null) => {
    if (!file) return;
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (!['txt', 'md', 'csv', 'pdf'].includes(ext)) {
      onNotify('error', 'Unsupported file', 'Upload .txt, .md, .csv, or .pdf files.');
      return;
    }

    setIsIngesting(true);
    try {
      let payload: Record<string, unknown> = {
        assistantId: assistant.id,
        source: file.name,
        sourceType: 'file',
        filename: file.name,
      };

      if (ext === 'pdf') {
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        payload.contentBase64 = btoa(binary);
      } else {
        payload.text = await file.text();
      }

      const res = await fetch('/api/kb/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as {
        chunkCount?: number;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || 'File ingestion failed');
      onNotify(
        'success',
        `${file.name} indexed`,
        `${data.chunkCount ?? 0} chunks embedded.`
      );
      await fetchKb();
    } catch (err) {
      onNotify(
        'error',
        'File upload failed',
        err instanceof Error ? err.message : 'Could not parse file.'
      );
    } finally {
      setIsIngesting(false);
    }
  };

  const handleIngestFaqs = async (e: React.FormEvent) => {
    e.preventDefault();
    const valid = faqPairs.filter((f) => f.q.trim() && f.a.trim());
    if (valid.length === 0) {
      onNotify('error', 'Add at least one complete Q&A pair.');
      return;
    }
    setIsIngesting(true);
    try {
      const res = await fetch('/api/kb/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assistantId: assistant.id,
          source: sourceTitle.trim() || `FAQ Set (${valid.length} items)`,
          sourceType: 'faq',
          faqs: valid,
        }),
      });
      const data = (await res.json()) as { chunkCount?: number; error?: string };
      if (!res.ok) throw new Error(data.error || 'FAQ ingestion failed');
      onNotify('success', 'FAQs embedded', `${data.chunkCount ?? 0} chunks indexed.`);
      setSourceTitle('');
      setFaqPairs([{ q: '', a: '' }]);
      await fetchKb();
    } catch (err) {
      onNotify(
        'error',
        'FAQ ingestion failed',
        err instanceof Error ? err.message : 'Unable to save FAQs.'
      );
    } finally {
      setIsIngesting(false);
    }
  };

  const handleDeleteDoc = async (docId: string) => {
    try {
      await fetch(`/api/kb/doc/${encodeURIComponent(docId)}`, { method: 'DELETE' });
      onNotify('info', 'Document removed');
      await fetchKb();
    } catch {
      onNotify('error', 'Failed to delete document');
    }
  };

  const handleResetSeed = async () => {
    try {
      const response = await fetch('/api/kb/reset-seed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assistantId: assistant.id }),
      });
      if (!response.ok) throw new Error('Restore failed');
      onNotify('success', 'Bundled municipality knowledge restored');
      await fetchKb();
    } catch {
      onNotify('error', 'Failed to restore bundled knowledge');
    }
  };

  const handleTestRetrieval = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    try {
      const res = await fetch('/api/kb/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assistantId: assistant.id,
          query: searchQuery.trim(),
          topK,
        }),
      });
      const data = (await res.json()) as {
        results?: SearchChunkResult[];
        retrievalMs?: number;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || 'Retrieval failed');
      setSearchResults(data.results ?? []);
      setLastRetrievalMs(data.retrievalMs ?? null);
      await fetchKb();
    } catch (err) {
      onNotify(
        'error',
        'Retrieval test failed',
        err instanceof Error ? err.message : 'Could not embed search query.'
      );
    } finally {
      setIsSearching(false);
    }
  };

  const canStuff = totalTokens < 30_000;

  return (
    <div className="max-w-6xl mx-auto p-6 lg:p-8 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-5 border-b border-slate-800/80">
        <div>
          <h1 className="text-2xl font-display font-semibold text-slate-100">
            Knowledge Base
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Company facts for <span className="text-slate-200 font-medium">{assistant.name} ({assistant.companyName})</span>. Chunked at ~500 tokens with 50-token overlap.
          </p>
        </div>

        {/* Context Strategy Control */}
        <div className="flex items-center gap-3">
          {assistant.id === MUNICIPALITY_ASSISTANT_ID && (
            <button
              type="button"
              onClick={handleResetSeed}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-700 bg-[#111827] hover:bg-slate-800 text-xs font-medium text-slate-200 cursor-pointer whitespace-nowrap"
            >
              <RotateCcw className="w-3.5 h-3.5 text-sky-400" />
              <span>Restore Bundled Knowledge</span>
            </button>
          )}
          <label
            className={`inline-flex items-center gap-2.5 px-3.5 py-2 rounded-lg border text-xs font-medium cursor-pointer whitespace-nowrap ${
              assistant.stuffAllContext
                ? 'border-sky-500/60 bg-sky-500/15 text-sky-200'
                : 'border-slate-700 bg-[#111827] text-slate-300'
            } ${!canStuff ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            <input
              type="checkbox"
              disabled={!canStuff}
              checked={assistant.stuffAllContext}
              onChange={(e) =>
                void onUpdateAssistant({
                  ...assistant,
                  stuffAllContext: e.target.checked,
                })
              }
              className="accent-sky-500"
            />
            <span>Stuff all into context (&lt;30k tokens)</span>
          </label>
        </div>
      </div>

      {/* Metrics Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-xl border border-slate-800/80 bg-[#111827] p-4">
          <p className="text-xs text-slate-400">Documents</p>
          <p className="mt-1 text-2xl font-display font-semibold tabular-nums text-slate-100">
            {documents.length}
          </p>
        </div>
        <div className="rounded-xl border border-slate-800/80 bg-[#111827] p-4">
          <p className="text-xs text-slate-400">Indexed Chunks</p>
          <p className="mt-1 text-2xl font-display font-semibold tabular-nums text-slate-100">
            {chunkCount}
          </p>
        </div>
        <div className="rounded-xl border border-slate-800/80 bg-[#111827] p-4">
          <p className="text-xs text-slate-400">Token Volume</p>
          <p className="mt-1 text-2xl font-display font-semibold tabular-nums text-slate-100">
            {totalTokens.toLocaleString()}
            <span className="text-xs font-normal text-slate-400 ml-1.5">/ 30,000</span>
          </p>
        </div>
        <div className="rounded-xl border border-slate-800/80 bg-[#111827] p-4">
          <p className="text-xs text-slate-400">Active Strategy</p>
          <p className="mt-1 text-base font-medium text-sky-400">
            {assistant.stuffAllContext && canStuff
              ? 'Full Context Stuffing'
              : 'Vector RAG (Top 4)'}
          </p>
          <p className="text-[11px] text-slate-400 font-mono tabular-nums mt-0.5">
            {embeddedCount}/{chunkCount} vectors ready
          </p>
        </div>
      </div>

      {/* Main Split: Ingestion + Test Retrieval */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left: Add Knowledge */}
        <div className="lg:col-span-7 rounded-xl border border-slate-800/80 bg-[#111827] p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-display font-semibold text-slate-100">
              Add Company Knowledge
            </h2>
            <div className="inline-flex p-1 rounded-lg bg-[#090D16] border border-slate-800">
              {(['text', 'file', 'faq'] as IngestTab[]).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setIngestTab(tab)}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                    ingestTab === tab
                      ? 'bg-slate-800 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {tab === 'text' ? 'Paste Text' : tab === 'file' ? 'Upload File' : 'FAQ Pairs'}
                </button>
              ))}
            </div>
          </div>

          {ingestTab === 'text' && (
            <form onSubmit={handleIngestText} className="space-y-4">
              <div>
                <label
                  htmlFor="kb-source"
                  className="block text-xs font-medium text-slate-300 mb-1.5"
                >
                  Document Title / Source
                </label>
                <input
                  id="kb-source"
                  type="text"
                  value={sourceTitle}
                  onChange={(e) => setSourceTitle(e.target.value)}
                  placeholder="e.g. Holiday Hours & Emergency Policy"
                  className="w-full rounded-lg bg-[#090D16] border border-slate-800 px-3.5 py-2 text-sm text-slate-100 focus:outline-none focus:border-sky-500"
                />
              </div>
              <div>
                <label
                  htmlFor="kb-paste"
                  className="block text-xs font-medium text-slate-300 mb-1.5"
                >
                  Knowledge Content
                </label>
                <textarea
                  id="kb-paste"
                  rows={7}
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  placeholder="Paste product specs, pricing tables, store policies, or scripts..."
                  className="w-full rounded-lg bg-[#090D16] border border-slate-800 px-3.5 py-2.5 text-sm text-slate-100 leading-relaxed focus:outline-none focus:border-sky-500"
                />
              </div>
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={isIngesting}
                  className="px-4 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 text-sm font-semibold transition-colors cursor-pointer disabled:opacity-50"
                >
                  {isIngesting ? 'Chunking & Embedding...' : 'Chunk & Embed'}
                </button>
              </div>
            </form>
          )}

          {ingestTab === 'file' && (
            <div className="space-y-4">
              <label className="flex flex-col items-center justify-center border border-dashed border-slate-700 hover:border-sky-500/60 rounded-xl bg-[#090D16] p-10 text-center cursor-pointer transition-colors">
                <Upload className="w-7 h-7 text-sky-400 mb-3" />
                <span className="text-sm font-medium text-slate-200">
                  {isIngesting
                    ? 'Parsing and embedding document...'
                    : 'Choose a .txt, .md, .csv, or .pdf file'}
                </span>
                <span className="mt-1 text-xs text-slate-400">
                  Max 6 MB. Extracted text is chunked into ~500-token blocks.
                </span>
                <input
                  type="file"
                  accept=".txt,.md,.csv,.pdf"
                  disabled={isIngesting}
                  onChange={(e) => {
                    void handleFileUpload(e.target.files?.[0] ?? null);
                    e.currentTarget.value = '';
                  }}
                  className="hidden"
                />
              </label>
            </div>
          )}

          {ingestTab === 'faq' && (
            <form onSubmit={handleIngestFaqs} className="space-y-4">
              <div>
                <label
                  htmlFor="kb-faq-title"
                  className="block text-xs font-medium text-slate-300 mb-1.5"
                >
                  FAQ Group Name
                </label>
                <input
                  id="kb-faq-title"
                  type="text"
                  value={sourceTitle}
                  onChange={(e) => setSourceTitle(e.target.value)}
                  placeholder="e.g. Ward Office FAQs"
                  className="w-full rounded-lg bg-[#090D16] border border-slate-800 px-3.5 py-2 text-sm text-slate-100 focus:outline-none focus:border-sky-500"
                />
              </div>

              <div className="space-y-3 max-h-72 overflow-y-auto pr-1">
                {faqPairs.map((pair, idx) => (
                  <div
                    key={idx}
                    className="p-3 rounded-lg border border-slate-800 bg-[#090D16] space-y-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-mono text-slate-400">
                        Pair {idx + 1}
                      </span>
                      {faqPairs.length > 1 && (
                        <button
                          type="button"
                          onClick={() =>
                            setFaqPairs((prev) => prev.filter((_, i) => i !== idx))
                          }
                          className="text-xs text-slate-400 hover:text-rose-400 cursor-pointer"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                    <input
                      type="text"
                      value={pair.q}
                      onChange={(e) =>
                        setFaqPairs((prev) =>
                          prev.map((p, i) => (i === idx ? { ...p, q: e.target.value } : p))
                        )
                      }
                      placeholder="Question (e.g. Do you accept walk-ins?)"
                      className="w-full rounded-md bg-[#111827] border border-slate-800 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-sky-500"
                    />
                    <textarea
                      rows={2}
                      value={pair.a}
                      onChange={(e) =>
                        setFaqPairs((prev) =>
                          prev.map((p, i) => (i === idx ? { ...p, a: e.target.value } : p))
                        )
                      }
                      placeholder="Answer..."
                      className="w-full rounded-md bg-[#111827] border border-slate-800 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-sky-500"
                    />
                  </div>
                ))}
              </div>

              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => setFaqPairs((prev) => [...prev, { q: '', a: '' }])}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-sky-400 hover:text-sky-300 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add FAQ Pair</span>
                </button>
                <button
                  type="submit"
                  disabled={isIngesting}
                  className="px-4 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 text-sm font-semibold transition-colors cursor-pointer disabled:opacity-50"
                >
                  {isIngesting ? 'Embedding...' : 'Embed FAQs'}
                </button>
              </div>
            </form>
          )}
        </div>

        {/* Right: Test Retrieval */}
        <div className="lg:col-span-5 rounded-xl border border-slate-800/80 bg-[#111827] p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-display font-semibold text-slate-100">
              Test Retrieval
            </h2>
            {lastRetrievalMs !== null && (
              <span className="text-xs font-mono tabular-nums text-emerald-400">
                {lastRetrievalMs} ms
              </span>
            )}
          </div>

          <form onSubmit={handleTestRetrieval} className="space-y-3">
            <div className="flex gap-2">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Ask e.g. What is your cancellation fee?"
                className="flex-1 rounded-lg bg-[#090D16] border border-slate-800 px-3.5 py-2 text-sm text-slate-100 focus:outline-none focus:border-sky-500"
              />
              <select
                aria-label="Top K results"
                value={topK}
                onChange={(e) => setTopK(parseInt(e.target.value, 10))}
                className="rounded-lg bg-[#090D16] border border-slate-800 px-2.5 py-2 text-xs font-mono text-slate-200 focus:outline-none focus:border-sky-500"
              >
                <option value={2}>Top 2</option>
                <option value={4}>Top 4</option>
                <option value={6}>Top 6</option>
              </select>
            </div>
            <button
              type="submit"
              disabled={isSearching || !searchQuery.trim()}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-slate-700 bg-[#090D16] hover:bg-slate-800 text-xs font-semibold text-slate-100 transition-colors cursor-pointer disabled:opacity-50"
            >
              <Search className="w-3.5 h-3.5 text-sky-400" />
              <span>{isSearching ? 'Searching Vectors...' : 'Run Cosine Similarity Search'}</span>
            </button>
          </form>

          <div className="space-y-2.5 max-h-96 overflow-y-auto pr-1">
            {searchResults.length === 0 ? (
              <p className="text-xs text-slate-400 py-6 text-center">
                Enter a caller question above to inspect matching chunks and similarity scores.
              </p>
            ) : (
              searchResults.map((chunk) => (
                <div
                  key={chunk.id}
                  className="p-3 rounded-lg border border-slate-800 bg-[#090D16] space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium text-slate-200 truncate">
                      {chunk.source}
                    </span>
                    <span className="font-mono tabular-nums text-sky-400 shrink-0">
                      {(chunk.similarity * 100).toFixed(1)}% match
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 leading-relaxed whitespace-pre-wrap">
                    {chunk.text}
                  </p>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Stored Documents Table */}
      <div className="rounded-xl border border-slate-800/80 bg-[#111827] overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-800/80 flex items-center justify-between">
          <h2 className="text-base font-display font-semibold text-slate-100">
            Loaded Documents
          </h2>
          <span className="text-xs text-slate-400 font-mono tabular-nums">
            {documents.length} sources
          </span>
        </div>

        {isLoading ? (
          <div className="p-6 text-sm text-slate-400">Loading knowledge sources...</div>
        ) : documents.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-400">
            No knowledge documents loaded for {assistant.name} yet. Add text, files, or FAQs above.
          </div>
        ) : (
          <div className="divide-y divide-slate-800/70">
            {documents.map((doc) => (
              <div
                key={doc.id}
                className="px-5 py-3.5 flex items-center justify-between gap-4 hover:bg-slate-800/25 transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <FileText className="w-4 h-4 text-sky-400 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-100 truncate">
                      {doc.source}
                    </p>
                    <div className="flex items-center gap-2 text-xs text-slate-400 mt-0.5">
                      <span>{doc.sourceType.toUpperCase()}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">{doc.chunkCount} chunks</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">
                        ~{doc.tokenEstimate.toLocaleString()} tokens
                      </span>
                    </div>
                  </div>
                </div>
                {doc.id === MUNICIPALITY_KNOWLEDGE_ID ? (
                  <span className="text-xs text-slate-400">Bundled</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleDeleteDoc(doc.id)}
                    aria-label={`Delete ${doc.source}`}
                    className="p-2 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 transition-colors cursor-pointer shrink-0"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
