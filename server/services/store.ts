import fs from 'node:fs';
import path from 'node:path';
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

const CURRENT_SEED_VERSION = 2;
const DATA_DIR = path.resolve(process.cwd(), 'data');
const STORE_PATH = path.join(DATA_DIR, 'store.json');

export const NEPALI_SEED_ASSISTANT_ID = 'anita-himalayan-dental-np';
export const ENGLISH_SEED_ASSISTANT_ID = 'aria-acme-dental';

const SEED_NEPALI_DOCS: Array<{
  source: string;
  sourceType: 'text' | 'faq';
  content: string;
}> = [
  {
    source: 'हिमालयन डेन्टल केयर — क्लिनिक समय र स्थान (Hours & Location)',
    sourceType: 'text',
    content: `हिमालयन डेन्टल केयर (Himalayan Dental Care) काठमाडौंको लाजिम्पाट, उत्तरढोका मार्ग, घर नम्बर २१० मा अवस्थित परिवार र कस्मेटिक दन्त क्लिनिक हो।
क्लिनिक खुल्ने समय:
आइतबारदेखि शुक्रबारसम्म: बिहान ८:०० बजेदेखि बेलुका ६:०० बजेसम्म।
शनिबार: बिहान ९:०० बजेदेखि दिउँसो २:०० बजेसम्म।
सार्वजनिक बिदाको दिन: क्लिनिक बन्द रहन्छ।
पार्किङ र पहुँच: बिरामीहरूका लागि क्लिनिकको पछाडिको प्राङ्गणमा निःशुल्क पार्किङ सुविधा उपलब्ध छ। क्लिनिकमा लिफ्ट र ह्वीलचेयरको सहज पहुँच छ।
सम्पर्क र आकस्मिक सेवा: मुख्य फोन नम्बर +९७७ १-५५५-०१९९ हो। क्लिनिक बन्द भएको समयमा अत्यधिक दाँत दुखेमा वा सुन्निएमा आकस्मिक कलब्याक अनुरोध छोड्न सकिन्छ।`,
  },
  {
    source: 'हिमालयन डेन्टल केयर — सेवा र शुल्क (Services & Pricing)',
    sourceType: 'text',
    content: `हिमालयन डेन्टल केयरका सेवा र शुल्क विवरण (नेपाली रुपैयाँमा):
- नियमित दाँत सफाइ र सम्पूर्ण जाँच (Routine Cleaning & Exam, ४५ मिनेट): १,५०० रुपैयाँ।
- डिजिटल एक्स-रे (Digital X-Ray): ८०० रुपैयाँ।
- सोही दिनको आकस्मिक जाँच (Same-Day Emergency Exam): १,००० रुपैयाँ (उपचारको खर्च जाँचपछि पहिले नै जानकारी गराइन्छ)।
- दाँत भर्ने (Composite Tooth-Colored Filling): एउटा सतहको २,२०० रुपैयाँदेखि ३,५०० रुपैयाँसम्म।
- क्लिनिकभित्र दाँत चम्काउने (In-Office Teeth Whitening): ८,५०० रुपैयाँ।
- पोर्सिलेन क्राउन / क्याप (Porcelain Dental Crown): १२,००० रुपैयाँ।
- दाँत मिलाउने तार / अलाईनर परामर्श (Braces / Aligner Consultation): निःशुल्क (३० मिनेटको परामर्श)।
- पीडारहित आरामका लागि नाइट्रस अक्साइड (Laughing Gas): १,२०० रुपैयाँ।`,
  },
  {
    source: 'हिमालयन डेन्टल केयर — बीमा, भुक्तानी र रद्द नीति (Insurance & Cancellation)',
    sourceType: 'text',
    content: `भुक्तानी र बीमा सुविधा:
हाम्रो क्लिनिकमा ई-सेवा (eSewa), खल्ती (Khalti), फोनपे (Fonepay QR), भिसा/मास्टरकार्ड र नगद भुक्तानी स्वीकार गरिन्छ।
हामी नेपाल लाइफ इन्स्योरेन्स, शिखर इन्स्योरेन्स र हिमालयन एभरेष्ट कर्पोरेट मेडिकल बीमाका बिलहरू दाबी (Claim) गर्नका लागि आधिकारिक भ्याट बिल उपलब्ध गराउँछौं। सरकारी स्वास्थ्य बीमा कार्यक्रम यहाँ लागू हुँदैन।
अपोइन्टमेन्ट रद्द (Cancellation) र ढिलो आउने नीति:
अपोइन्टमेन्ट रद्द गर्न वा समय सार्न कम्तीमा २४ घण्टा अगाडि जानकारी गराउनुपर्छ। २४ घण्टाभन्दा कम समयमा जानकारी नदिई नआएमा वा रद्द गरेमा ५०० रुपैयाँ शुल्क लाग्नेछ। निर्धारित समयभन्दा १५ मिनेटभन्दा बढी ढिलो भएमा अर्को समय लिनुपर्ने हुन सक्छ।`,
  },
  {
    source: 'हिमालयन डेन्टल केयर — प्रायः सोधिने प्रश्नहरू (Patient FAQs)',
    sourceType: 'faq',
    content: `Q: के यहाँ साना बालबालिकाको दाँतको उपचार हुन्छ?
A: हजुर, हिमालयन डेन्टल केयरमा ४ वर्ष र सोभन्दा माथिका बालबालिकाको दाँत सफाइ, फ्लोराइड र नियमित जाँच गरिन्छ।

Q: पहिलो पटक आउँदा के लिएर आउनुपर्छ?
A: कृपया अपोइन्टमेन्ट समयभन्दा १० मिनेट अगाडि आउनुहोला र परिचयपत्र तथा पहिले खाँदै गरेको औषधिको सूची भए लिएर आउनुहोला।

Q: फोनबाट अपोइन्टमेन्ट कसरी बुक गर्ने?
A: तपाईंले आफ्नो पूरा नाम, फोन नम्बर र चाहेको दिन र समय बताएपछि म यहींबाट अपोइन्टमेन्ट बुक गरिदिनेछु।`,
  },
];

const SEED_ACME_DOCS: Array<{
  source: string;
  sourceType: 'text' | 'faq';
  content: string;
}> = [
  {
    source: 'Acme Dental — Clinic Overview, Hours & Location',
    sourceType: 'text',
    content: `Acme Dental is a family and cosmetic dentistry practice located at 742 Evergreen Terrace, Suite 210, Austin, Texas 78701.
Opening Hours:
Monday through Friday: 8:00 AM to 6:00 PM.
Saturday: 9:00 AM to 2:00 PM.
Sunday: Closed.
Parking & Access: Free dedicated patient parking is available directly behind the building off Oak Street, and the suite is wheelchair accessible with elevator access from the lobby.
Phone & After-Hours: Main office phone is (555) 010-0199. Established patients experiencing severe pain or swelling after hours can leave an urgent callback request with the front desk.`,
  },
  {
    source: 'Acme Dental — Services & Transparent Pricing',
    sourceType: 'text',
    content: `Acme Dental Standard Self-Pay Pricing:
- Routine Cleaning and Comprehensive Exam (60 minutes): $145. Includes ultrasonic scaling, polish, and dentist exam.
- Digital X-Rays (Full Mouth or Bitewing Set): $95.
- Same-Day Emergency Exam: $120 exam fee (treatment quoted separately before any procedure).
- Composite Tooth-Colored Filling: $195 for single surface, up to $320 for multi-surface.
- In-Office Professional Teeth Whitening: $399 per session (60 minutes).
- Porcelain Dental Crown: $1,150.
- Invisalign Clear Aligner Consultation: Complimentary (free 30-minute 3D scan and treatment estimate).
- Nitrous Oxide (Laughing Gas) Comfort Option: $75 per visit.`,
  },
  {
    source: 'Acme Dental — Insurance, Financing & Cancellation Policy',
    sourceType: 'text',
    content: `Insurance Accepted:
Acme Dental is in-network with Delta Dental PPO, Cigna Dental, Aetna, MetLife, and BlueCross BlueShield Dental.
Out-of-network PPO plans can be submitted on the patient's behalf as a courtesy.
We do not accept Medicaid or HMO dental plans.
Financing: CareCredit 0% APR financing for 12 months is available for treatments over $500. Payment is due at the time of service via Visa, Mastercard, American Express, HSA, FSA, or debit.
Cancellation and Late Policy:
We require at least 24 hours advance notice to cancel or reschedule an appointment. Cancellations or no-shows with less than 24 hours notice incur a $50 late cancellation fee. Patients arriving more than 15 minutes late may need to reschedule so other patients are not delayed.`,
  },
  {
    source: 'Acme Dental — Patient FAQs',
    sourceType: 'faq',
    content: `Q: Do you treat children or pediatric patients?
A: Yes, Acme Dental welcomes children ages 4 and older for cleanings, fluoride treatments, and gentle checkups.

Q: What should I bring to my first appointment?
A: Please arrive 10 minutes early with a photo ID, your dental insurance card if applicable, and a list of any current medications.

Q: How do I book an appointment?
A: You can book right over the phone by sharing your full name, callback phone number, and preferred day and time.`,
  },
];

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

function buildDocsAndChunks(
  assistantId: string,
  prefix: string,
  docs: Array<{ source: string; sourceType: 'text' | 'faq'; content: string }>,
  now: string
): { documents: KnowledgeDocument[]; chunks: KnowledgeChunk[] } {
  const documents: KnowledgeDocument[] = [];
  const chunks: KnowledgeChunk[] = [];

  docs.forEach((doc, docIdx) => {
    const docId = `${prefix}-doc-${docIdx + 1}`;
    const docChunks = chunkText(doc.content, 500, 50);
    documents.push({
      id: docId,
      assistantId,
      source: doc.source,
      sourceType: doc.sourceType,
      tokenEstimate: estimateTokens(doc.content),
      chunkCount: docChunks.length,
      createdAt: now,
    });
    docChunks.forEach((chunkStr, chunkIndex) => {
      chunks.push({
        id: `${docId}-chunk-${chunkIndex}`,
        docId,
        assistantId,
        source: doc.source,
        chunkIndex,
        text: chunkStr,
        tokenEstimate: estimateTokens(chunkStr),
      });
    });
  });

  return { documents, chunks };
}

function createNepaliSeedAssistant(now: string): Assistant {
  return {
    id: NEPALI_SEED_ASSISTANT_ID,
    name: 'अनिता (Anita)',
    companyName: 'हिमालयन डेन्टल केयर',
    phoneNumber: '+977 1-555-0199',
    greetFirst: true,
    firstMessage:
      'नमस्ते, हिमालयन डेन्टल केयरमा फोन गर्नुभएकोमा धन्यवाद। म अनिता बोल्दैछु, हजुरलाई कसरी सहयोग गर्न सक्छु?',
    systemPrompt:
      'तपाईं काठमाडौंको लाजिम्पाटस्थित हिमालयन डेन्टल केयरको विनम्र र सहयोगी फ्रन्ट-डेस्क रिसेप्सनिस्ट अनिता हुनुहुन्छ। बिरामीहरूलाई क्लिनिक खुल्ने समय, सेवा, शुल्क, बीमा/भुक्तानी, र अपोइन्टमेन्ट बुक गर्न मद्दत गर्नुहोस्।',
    language: 'ne-NP',
    voice: 'Kore',
    styleInstruction: 'Speak warmly, politely, and naturally in Nepali at a calm front-desk pace',
    temperature: 0.3,
    maxSentences: 2,
    mode: 'pipeline',
    stuffAllContext: false,
    createdAt: now,
    updatedAt: now,
  };
}

function createEnglishSeedAssistant(now: string): Assistant {
  return {
    id: ENGLISH_SEED_ASSISTANT_ID,
    name: 'Aria',
    companyName: 'Acme Dental',
    phoneNumber: '+1 (555) 010-0199',
    greetFirst: true,
    firstMessage:
      'Thank you for calling Acme Dental, this is Aria speaking. How can I help you today?',
    systemPrompt:
      'You are Aria, the friendly front-desk receptionist at Acme Dental in Austin, Texas. Help callers with clinic hours, services, pricing, insurance questions, and booking dental appointments.',
    language: 'en-US',
    voice: 'Kore',
    styleInstruction: 'Speak warmly, clearly, and at a calm, natural front-desk pace',
    temperature: 0.3,
    maxSentences: 2,
    mode: 'pipeline',
    stuffAllContext: false,
    createdAt: now,
    updatedAt: now,
  };
}

function createSeedStore(): StoreData {
  const now = new Date().toISOString();
  const nepaliAssistant = createNepaliSeedAssistant(now);
  const englishAssistant = createEnglishSeedAssistant(now);

  const npKb = buildDocsAndChunks(NEPALI_SEED_ASSISTANT_ID, 'seed-np', SEED_NEPALI_DOCS, now);
  const enKb = buildDocsAndChunks(ENGLISH_SEED_ASSISTANT_ID, 'seed-doc', SEED_ACME_DOCS, now);

  return {
    seedVersion: CURRENT_SEED_VERSION,
    assistants: [nepaliAssistant, englishAssistant],
    documents: [...npKb.documents, ...enKb.documents],
    chunks: [...npKb.chunks, ...enKb.chunks],
    calls: [],
    appointments: [],
  };
}

let storeCache: StoreData | null = null;

export function getStore(): StoreData {
  if (storeCache) return storeCache;

  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(STORE_PATH)) {
      const raw = fs.readFileSync(STORE_PATH, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoreData>;
      if (parsed && Array.isArray(parsed.assistants) && parsed.assistants.length > 0) {
        const loaded: StoreData = {
          seedVersion: parsed.seedVersion ?? 1,
          assistants: parsed.assistants.map((a) => ({
            ...a,
            greetFirst: typeof a.greetFirst === 'boolean' ? a.greetFirst : true,
          })),
          documents: parsed.documents ?? [],
          chunks: parsed.chunks ?? [],
          calls: parsed.calls ?? [],
          appointments: parsed.appointments ?? [],
        };

        // Ensure Nepali seed assistant is present and prioritized when upgrading from v1
        if ((loaded.seedVersion ?? 1) < CURRENT_SEED_VERSION) {
          const now = new Date().toISOString();
          if (!loaded.assistants.some((a) => a.id === NEPALI_SEED_ASSISTANT_ID)) {
            const npAst = createNepaliSeedAssistant(now);
            const npKb = buildDocsAndChunks(
              NEPALI_SEED_ASSISTANT_ID,
              'seed-np',
              SEED_NEPALI_DOCS,
              now
            );
            loaded.assistants.unshift(npAst);
            loaded.documents.unshift(...npKb.documents);
            loaded.chunks.unshift(...npKb.chunks);
          }
          loaded.seedVersion = CURRENT_SEED_VERSION;
          storeCache = loaded;
          saveStore();
          return storeCache;
        }

        storeCache = loaded;
        return storeCache;
      }
    }
  } catch (err) {
    console.warn('Failed to load existing store.json, initializing fresh seed store:', err);
  }

  storeCache = createSeedStore();
  saveStore();
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
  const store = getStore();
  const now = new Date().toISOString();
  if (assistantId === NEPALI_SEED_ASSISTANT_ID) {
    const npKb = buildDocsAndChunks(NEPALI_SEED_ASSISTANT_ID, 'seed-np', SEED_NEPALI_DOCS, now);
    store.documents = store.documents
      .filter((d) => d.assistantId !== NEPALI_SEED_ASSISTANT_ID)
      .concat(npKb.documents);
    store.chunks = store.chunks
      .filter((c) => c.assistantId !== NEPALI_SEED_ASSISTANT_ID)
      .concat(npKb.chunks);
    saveStore();
    return;
  }
  if (assistantId === ENGLISH_SEED_ASSISTANT_ID) {
    const enKb = buildDocsAndChunks(ENGLISH_SEED_ASSISTANT_ID, 'seed-doc', SEED_ACME_DOCS, now);
    store.documents = store.documents
      .filter((d) => d.assistantId !== ENGLISH_SEED_ASSISTANT_ID)
      .concat(enKb.documents);
    store.chunks = store.chunks
      .filter((c) => c.assistantId !== ENGLISH_SEED_ASSISTANT_ID)
      .concat(enKb.chunks);
    saveStore();
  }
}
