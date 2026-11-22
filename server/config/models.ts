/**
 * Central Gemini model configuration for Fedora-Pilot.
 * IDs are verified against the active AI Studio model list, with ordered
 * fallbacks for resilient execution across environments.
 */
export const MODEL_CONFIG = {
  // Primary fast text/reasoning model (AI Studio active Flash model)
  LLM_MODEL: process.env.FEDORA_LLM_MODEL || 'gemini-3.1-flash-lite',
  LLM_FALLBACK_MODELS: ['gemini-4-hydrogen', 'gemini-3.8-flash'],

  // Low-latency Text-to-Speech model (24kHz mono 16-bit PCM)
  TTS_MODEL: process.env.FEDORA_TTS_MODEL || 'gemini-3.8-flash-lite-tts',
  TTS_FALLBACK_MODELS: ['gemini-3.8-flash-tts', 'gemini-2.5-flash-preview-tts'],

  // Real-time bidirectional audio Live API model
  LIVE_MODEL: process.env.FEDORA_LIVE_MODEL || 'gemini-3.8-live',
  LIVE_FALLBACK_MODELS: ['gemini-3.1-flash-live-preview'],

  // Vector embedding model for RAG chunk indexing & cosine similarity
  EMBED_MODEL: process.env.FEDORA_EMBED_MODEL || 'gemini-embedding-2',
  EMBED_FALLBACK_MODELS: ['gemini-embedding-001'],

  // Fallback audio transcription model when Web Speech API is unavailable
  TRANSCRIBE_MODEL: process.env.FEDORA_TRANSCRIBE_MODEL || 'gemini-3.5-transcribe',
  TRANSCRIBE_FALLBACK_MODELS: ['gemini-3.1-flash-lite', 'gemini-4-hydrogen'],
} as const;
