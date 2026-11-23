# Fedora-Pilot

Fedora-Pilot is a Vapi-style voice AI agent platform prototype built with React, TypeScript, Tailwind CSS, and a Node/Express + WebSocket backend powered by the `@google/genai` SDK.

Users can configure voice assistants, upload and embed company knowledge, place realistic phone calls in the Dialer UI (supporting both **Pipeline Mode** and **Realtime Fedora Pilot Mode**), interrupt the agent mid-sentence (barge-in), inspect per-turn latency metrics, and review AI-summarized call logs.

---

## Setup Steps

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Configure environment variables**
   Set `GEMINI_API_KEY` in your environment (or `.env` locally — never expose it to the browser).
   ```bash
   export GEMINI_API_KEY="your-gemini-api-key"
   ```

3. **Start the full-stack dev server (port 3000)**
   ```bash
   npm run dev
   ```
   Or build and run in production mode:
   ```bash
   npm run build
   NODE_ENV=production npm start
   ```

4. **Model Configuration**
   All Gemini model IDs and fallback lists live in `server/config/models.ts`:
   - `LLM_MODEL`: `gemini-3.1-flash-lite` (fallback: `gemini-4-hydrogen`, `gemini-3.8-flash`)
   - `TTS_MODEL`: `gemini-3.8-flash-lite-tts` (fallback: `gemini-3.8-flash-tts`, `gemini-2.5-flash-preview-tts`)
   - `LIVE_MODEL`: `gemini-3.8-live` (fallback: `gemini-3.1-flash-live-preview`)
   - `EMBED_MODEL`: `gemini-embedding-2` (fallback: `gemini-embedding-001`)
   - `TRANSCRIBE_MODEL`: `gemini-3.5-transcribe` (fallback: `gemini-4-hydrogen`)

---

## Dashboard API key settings

Set `DASHBOARD_SETTINGS_PASSWORD` in your Render service's Environment settings, or in `.env` for local development. Open **Settings** in the app to enter a new Gemini API key and the settings password. New requests and calls use the saved key. Select **Reset token count when saving** to start the server's reported usage counter at zero. The counter also starts at zero on server restart.

Gemini rate limits are shared by keys from the same Google project. To switch quotas, use a key from a project with available quota. [Gemini API rate limits](https://aistudio.google.com/docs/rate-limits)

The dashboard key is stored in `data/.env.gemini-key` and takes precedence over `GEMINI_API_KEY`. To retain it across Render restarts and redeploys, mount a persistent disk at the app's `data` directory.

---

## Architecture Highlights

- **Pipeline Mode (`STT -> RAG -> LLM Stream -> Sentence-Chunked TTS`)**
  - Uses browser `SpeechRecognition` (`ne-NP`, `en-US`, etc.) with ~700ms endpointing, automatic silent fallback to `MediaRecorder` + `/api/stt`, and a 1-click `STT: Gemini Audio` mode for Devanagari Nepali accuracy.
  - Embeds queries and retrieves top-4 chunks via cosine similarity (or injects the entire KB when `< 30k` tokens and "Stuff all into context" is enabled).
  - Streams LLM responses via SSE and splits sentences incrementally (including Devanagari Purnaviram `।` / `॥`), prefetching TTS audio per sentence so 24kHz 16-bit mono raw PCM buffers play back-to-back with zero gaps.
  - Pre-caches `firstMessage` audio while the ringback tone plays so Connected playback starts immediately.
  - Supports instant **barge-in**: aborts in-flight LLM/TTS requests, flushes queued WebAudio buffers, and truncates the agent transcript to what was actually spoken.
- **Realtime Mode (`WS /api/live`)**
  - Captures 16kHz 16-bit PCM via a browser `AudioWorklet` and streams over WebSocket to `ai.live.connect`.
  - Streams 24kHz PCM audio back to WebAudio with input/output transcription, tool calling, and server interruption queue flushing.
- **Tools**: `book_appointment(name, phone, datetime)`, `transfer_to_human(department)`, and `end_call(reason)`.

---

## Demo Script — Nepali Default (`अनिता (Anita) — हिमालयन डेन्टल केयर` · `+977 1-555-0199`)

Open the **Dialer** screen (preloaded with **अनिता (Anita) — हिमालयन डेन्टल केयर** in `ne-NP`) and click **Start Voice Call**. Once Anita finishes her Nepali greeting, test these 5 prompts in order (an English **Aria — Acme Dental** assistant is also available in the sidebar):

1. **समय र पार्किङ — Hours & Parking (Grounded Retrieval)**
   > *"शनिबार क्लिनिक कति बजे खुल्छ र बिरामीको लागि पार्किङ सुविधा छ?"*
   - Expected: Saturday 9:00 AM to 2:00 PM (बिहान ९:०० बजेदेखि दिउँसो २:०० बजेसम्म) and free parking behind the clinic in Lazimpat.

2. **सेवा र शुल्क — Services & Pricing (Multi-item Grounding)**
   > *"नियमित दाँत सफाइ र क्लिनिकभित्र दाँत चम्काउनेको शुल्क कति लाग्छ?"*
   - Expected: Routine cleaning & exam is 1,500 NPR (एक हजार पाँच सय रुपैयाँ); in-office whitening is 8,500 NPR (आठ हजार पाँच सय रुपैयाँ).

3. **बीमा र अपोइन्टमेन्ट बुकिङ — Insurance & `book_appointment` Tool**
   > *"यहाँ शिखर इन्स्योरेन्सको बिल दाबी चल्छ? मेरो मंगलबार दिउँसो २ बजेको अपोइन्टमेन्ट बुक गरिदिनुहोस्। मेरो नाम सुमन थापा र फोन नम्बर ९८४१००११२२ हो।"*
   - Expected: Confirms Shikhar Insurance VAT claim bills are provided, repeats back name/number/time in Nepali, invokes `book_appointment`, and displays the booking in the Debug Drawer.

4. **ज्ञान बाहिरको प्रश्न — Out-of-Knowledge Guardrail**
   > *"के तपाईंहरू इलेक्ट्रिक टूथब्रश बेच्नुहुन्छ वा कपाल प्रत्यारोपण सेवा दिनुहुन्छ?"*
   - Expected: Politely declines to guess and offers to take a message or transfer to a human representative.

5. **अवरोध परीक्षण — Interruption / Barge-In Test**
   > *"कृपया तपाईंहरूको क्लिनिकका सबै सेवा र शुल्कहरू विस्तारमा भनिदिनुहोस् न?"*
   - Speak over Anita mid-sentence to interrupt playback immediately and inspect `· interrupted` truncation in the transcript.

