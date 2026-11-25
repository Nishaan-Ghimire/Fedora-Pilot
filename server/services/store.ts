import fs from 'node:fs';
import path from 'node:path';
import { MUNICIPALITY_ASSISTANT_ID, MUNICIPALITY_GREETING, MUNICIPALITY_KNOWLEDGE_ID } from '../../src/municipality.ts';
import type {
  Appointment,
  Assistant,
  CallLog,
  KnowledgeChunk,
  KnowledgeDocument,
} from '../../src/types.ts';

export interface StoreData {
  seedVersion?: number;
  assistants: Assistant[];
  documents: KnowledgeDocument[];
  chunks: KnowledgeChunk[];
  calls: CallLog[];
  appointments: Appointment[];
}

const CURRENT_SEED_VERSION = 3;
const DATA_DIR = path.resolve(process.cwd(), 'data');
const STORE_PATH = path.join(DATA_DIR, 'store.json');
const LEGACY_SEED_IDS = new Set(['anita-himalayan-dental-np', 'aria-acme-dental']);

export const MUNICIPALITY_SYSTEM_PROMPT = fs.readFileSync(
  new URL('../config/municipality/system-prompt.ne.md', import.meta.url), 'utf8'
);
export const MUNICIPALITY_KNOWLEDGE = fs.readFileSync(
  new URL('../config/municipality/knowledge-base.ne.md', import.meta.url), 'utf8'
);

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.trim().length / 4));
}

export function chunkText(
  text: string,
  targetTokens = 500,
  overlapTokens = 50
): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (!clean) return [];

  const targetChars = targetTokens * 4;
  const overlapChars = overlapTokens * 4;

  if (clean.length <= targetChars) {
    return [clean];
  }

  const paragraphs = clean.split(/\n{2,}/);
  const chunks: string[] = [];
  let buffer = '';

  const pushChunk = (segment: string) => {
    const trimmed = segment.trim();
    if (trimmed) chunks.push(trimmed);
  };

  for (const para of paragraphs) {
    const trimmedPara = para.trim();
    if (!trimmedPara) continue;

    if ((buffer + '\n\n' + trimmedPara).length <= targetChars) {
      buffer = buffer ? `${buffer}\n\n${trimmedPara}` : trimmedPara;
      continue;
    }

    if (buffer) {
      pushChunk(buffer);
      const tail = buffer.slice(Math.max(0, buffer.length - overlapChars));
      buffer = tail ? `${tail}\n\n${trimmedPara}` : trimmedPara;
    } else {
      buffer = trimmedPara;
    }

    while (buffer.length > targetChars) {
      let cut = Math.max(
        buffer.lastIndexOf('। ', targetChars),
        buffer.lastIndexOf('. ', targetChars)
      );
      if (cut < targetChars * 0.5) {
        cut = buffer.lastIndexOf(' ', targetChars);
      }
      if (cut < targetChars * 0.4) {
        cut = targetChars;
      } else {
        cut += 1;
      }

      const slice = buffer.slice(0, cut).trim();
      pushChunk(slice);
      const overlapStart = Math.max(0, cut - overlapChars);
      buffer = buffer.slice(overlapStart).trim();
    }
  }

  if (buffer.trim()) {
    pushChunk(buffer);
  }

  return chunks;
}

function buildMunicipalityKnowledge(now: string) {
  const source = 'सुन्दरहरैँचा नगरपालिका — ज्ञान–आधार';
  const chunks = chunkText(MUNICIPALITY_KNOWLEDGE);
  const document: KnowledgeDocument = {
    id: MUNICIPALITY_KNOWLEDGE_ID,
    assistantId: MUNICIPALITY_ASSISTANT_ID,
    source,
    sourceType: 'text',
    tokenEstimate: estimateTokens(MUNICIPALITY_KNOWLEDGE),
    chunkCount: chunks.length,
    createdAt: now,
  };

  return {
    document,
    chunks: chunks.map((text, chunkIndex): KnowledgeChunk => ({
      id: `${document.id}-chunk-${chunkIndex}`,
      docId: document.id,
      assistantId: document.assistantId,
      source,
      chunkIndex,
      text,
      tokenEstimate: estimateTokens(text),
    })),
  };
}

function createMunicipalityAssistant(now: string): Assistant {
  return {
    id: MUNICIPALITY_ASSISTANT_ID,
    name: 'नगरपालिका एआई सहयोगी',
    companyName: 'सुन्दरहरैँचा नगरपालिका',
    phoneNumber: '+977 21-547050',
    greetFirst: true,
    firstMessage: MUNICIPALITY_GREETING,
    systemPrompt: MUNICIPALITY_SYSTEM_PROMPT,
    language: 'ne-NP',
    voice: 'Kore',
    styleInstruction: 'Speak warmly, politely, and naturally with a local Nepali accent',
    temperature: 0.3,
    maxSentences: 5,
    mode: 'pipeline',
    stuffAllContext: true,
    createdAt: now,
    updatedAt: now,
  };
}

function restoreMunicipalityKnowledge(store: StoreData, now: string): void {
  const knowledge = buildMunicipalityKnowledge(now);
  store.documents = [
    knowledge.document,
    ...store.documents.filter((doc) => doc.id !== MUNICIPALITY_KNOWLEDGE_ID),
  ];
  store.chunks = [
    ...knowledge.chunks,
    ...store.chunks.filter((chunk) => chunk.docId !== MUNICIPALITY_KNOWLEDGE_ID),
  ];
}

let storeCache: StoreData | null = null;

export function getStore(): StoreData {
  if (storeCache) return storeCache;

  let parsed: Partial<StoreData> = {};
  try {
    parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) ?? {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('Failed to load existing store.json, initializing fresh seed store:', err);
    }
  }

  const store: StoreData = {
    seedVersion: CURRENT_SEED_VERSION,
    assistants: (Array.isArray(parsed.assistants) ? parsed.assistants : []).map((assistant) => ({
      ...assistant,
      greetFirst: assistant.greetFirst ?? true,
    })),
    documents: parsed.documents ?? [],
    chunks: parsed.chunks ?? [],
    calls: parsed.calls ?? [],
    appointments: parsed.appointments ?? [],
  };

  const municipality = store.assistants.find((assistant) => assistant.id === MUNICIPALITY_ASSISTANT_ID);
  const needsMigration = (parsed.seedVersion ?? 1) < CURRENT_SEED_VERSION;
  if (needsMigration) {
    store.assistants = store.assistants.filter((assistant) => !LEGACY_SEED_IDS.has(assistant.id));
    store.documents = store.documents.filter((doc) => !LEGACY_SEED_IDS.has(doc.assistantId));
    store.chunks = store.chunks.filter((chunk) => !LEGACY_SEED_IDS.has(chunk.assistantId));
  }

  const now = new Date().toISOString();
  if (!municipality) store.assistants.unshift(createMunicipalityAssistant(now));
  // The checked-in prompt is authoritative even for a persisted store.
  if (municipality) {
    municipality.systemPrompt = MUNICIPALITY_SYSTEM_PROMPT;
    municipality.firstMessage = MUNICIPALITY_GREETING;
  }

  const missingKnowledge = !store.documents.some((doc) => doc.id === MUNICIPALITY_KNOWLEDGE_ID) ||
    !store.chunks.some((chunk) => chunk.docId === MUNICIPALITY_KNOWLEDGE_ID);
  if (needsMigration || missingKnowledge) restoreMunicipalityKnowledge(store, now);

  storeCache = store;
  if (needsMigration || !municipality || missingKnowledge) saveStore();
  return storeCache;
}

export function saveStore(): void {
  if (!storeCache) return;
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const tmpPath = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(storeCache, null, 2), 'utf8');
  fs.renameSync(tmpPath, STORE_PATH);
}

export function resetSeedKnowledgeForAssistant(assistantId: string): void {
  if (assistantId !== MUNICIPALITY_ASSISTANT_ID) return;
  restoreMunicipalityKnowledge(getStore(), new Date().toISOString());
  saveStore();
}
