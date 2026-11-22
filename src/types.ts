export type AgentMode = 'pipeline' | 'realtime';

export type VoiceName = 'Kore' | 'Puck' | 'Charon' | 'Aoede' | 'Fenrir' | 'Zephyr';

export interface VoiceOption {
  name: VoiceName;
  tone: string;
  genderLabel: string;
}

export const VOICE_OPTIONS: VoiceOption[] = [
  { name: 'Kore', tone: 'Warm, poised, clear front-desk tone', genderLabel: 'Female' },
  { name: 'Aoede', tone: 'Bright, expressive, conversational', genderLabel: 'Female' },
  { name: 'Zephyr', tone: 'Calm, crisp, reassuring', genderLabel: 'Neutral' },
  { name: 'Puck', tone: 'Upbeat, energetic, friendly', genderLabel: 'Male' },
  { name: 'Charon', tone: 'Steady, authoritative, composed', genderLabel: 'Male' },
  { name: 'Fenrir', tone: 'Deep, confident, unhurried', genderLabel: 'Male' },
];

export interface Assistant {
  id: string;
  name: string;
  companyName: string;
  phoneNumber: string;
  greetFirst: boolean;
  firstMessage: string;
  systemPrompt: string;
  language: string;
  voice: VoiceName;
  styleInstruction: string;
  temperature: number;
  maxSentences: number;
  mode: AgentMode;
  stuffAllContext: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeChunk {
  id: string;
  docId: string;
  assistantId: string;
  source: string;
  chunkIndex: number;
  text: string;
  tokenEstimate: number;
  embedding?: number[];
}

export interface KnowledgeDocument {
  id: string;
  assistantId: string;
  source: string;
  sourceType: 'text' | 'file' | 'faq';
  tokenEstimate: number;
  chunkCount: number;
  createdAt: string;
}

export interface SearchChunkResult {
  id: string;
  source: string;
  chunkIndex: number;
  text: string;
  similarity: number;
  tokenEstimate: number;
}

export interface TurnMetrics {
  turnIndex: number;
  mode: AgentMode;
  userText: string;
  endpointingDelayMs: number;
  retrievalMs: number;
  llmTtftMs: number;
  ttsTtfaMs: number;
  totalLatencyMs: number;
  chunksUsed: SearchChunkResult[];
  contextStrategy: 'rag' | 'stuffed';
  interrupted?: boolean;
  timestamp: string;
}

export interface TranscriptEntry {
  id: string;
  role: 'user' | 'agent' | 'system';
  text: string;
  isInterim?: boolean;
  interrupted?: boolean;
  timestamp: string;
  toolEvent?: {
    name: string;
    args: Record<string, unknown>;
    result: Record<string, unknown>;
  };
}

export interface Appointment {
  id: string;
  assistantId: string;
  name: string;
  phone: string;
  datetime: string;
  createdAt: string;
}

export interface CallLog {
  id: string;
  assistantId: string;
  assistantName: string;
  phoneNumber: string;
  mode: AgentMode;
  durationSec: number;
  startedAt: string;
  endedAt: string;
  transcript: TranscriptEntry[];
  turnMetrics: TurnMetrics[];
  summary: string;
  outcome: string;
  appointmentsBooked: Appointment[];
  transfers: Array<{ department: string; timestamp: string }>;
}

export type CallState = 'idle' | 'dialing' | 'ringing' | 'connected' | 'ended';
