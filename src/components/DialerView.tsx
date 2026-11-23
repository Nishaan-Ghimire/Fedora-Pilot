import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  CalendarCheck2,
  ChevronDown,
  ChevronUp,
  Delete,
  Mic,
  MicOff,
  PanelRightOpen,
  Phone,
  PhoneForwarded,
  PhoneOff,
  Send,
  Sparkles,
} from 'lucide-react';
import type {
  AgentMode,
  Appointment,
  Assistant,
  CallLog,
  CallState,
  SearchChunkResult,
  TranscriptEntry,
  TurnMetrics,
} from '../types';
import {
  PcmStreamPlayer,
  RingbackTone,
  extractCompleteSentences,
  playDtmfDigit,
  startRealtimeMicWorklet,
  type RealtimeMicHandle,
} from '../utils/audio';

interface DialerViewProps {
  assistant: Assistant;
  appointments: Appointment[];
  onSwitchMode: (mode: AgentMode) => void;
  onToggleGreetFirst: () => void;
  onAppointmentCreated: (appt: Appointment) => void;
  onCallSaved: (call: CallLog) => void;
  onNotify: (type: 'error' | 'success' | 'info', title: string, detail?: string) => void;
}

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: SpeechRecognitionResultLike;
  };
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

const COUNTRY_CODES = [
  { code: '+977', label: 'NP (+977)' },
  { code: '+1', label: 'US/CA (+1)' },
  { code: '+44', label: 'UK (+44)' },
  { code: '+61', label: 'AU (+61)' },
  { code: '+49', label: 'DE (+49)' },
  { code: '+91', label: 'IN (+91)' },
];

const KEYPAD_KEYS = [
  { digit: '1', sub: '' },
  { digit: '2', sub: 'ABC' },
  { digit: '3', sub: 'DEF' },
  { digit: '4', sub: 'GHI' },
  { digit: '5', sub: 'JKL' },
  { digit: '6', sub: 'MNO' },
  { digit: '7', sub: 'PQRS' },
  { digit: '8', sub: 'TUV' },
  { digit: '9', sub: 'WXYZ' },
  { digit: '*', sub: '' },
  { digit: '0', sub: '+' },
  { digit: '#', sub: '' },
];

const NEPALI_DEMO_SCRIPT_QUESTIONS = [
  {
    label: '1. समय र पार्किङ (Hours & Parking)',
    text: 'शनिबार क्लिनिक कति बजे खुल्छ र बिरामीको लागि पार्किङ सुविधा छ?',
  },
  {
    label: '2. सेवा र शुल्क (Pricing)',
    text: 'नियमित दाँत सफाइ र क्लिनिकभित्र दाँत चम्काउनेको शुल्क कति लाग्छ?',
  },
  {
    label: '3. बीमा र बुकिङ (Insurance & Booking)',
    text: 'यहाँ शिखर इन्स्योरेन्सको बिल दाबी चल्छ? मेरो मंगलबार दिउँसो २ बजेको अपोइन्टमेन्ट बुक गरिदिनुहोस्। मेरो नाम सुमन थापा र फोन नम्बर ९८४१००११२२ हो।',
  },
  {
    label: '4. ज्ञान बाहिरको प्रश्न (Guardrail)',
    text: 'के तपाईंहरू इलेक्ट्रिक टूथब्रश बेच्नुहुन्छ वा कपाल प्रत्यारोपण सेवा दिनुहुन्छ?',
  },
  {
    label: '5. अवरोध परीक्षण (Barge-In Test)',
    text: 'कृपया तपाईंहरूको क्लिनिकका सबै सेवा र शुल्कहरू विस्तारमा भनिदिनुहोस् न?',
  },
];

const DEMO_SCRIPT_QUESTIONS = [
  {
    label: '1. Hours & Parking',
    text: 'What are your opening hours on Saturday, and is there patient parking?',
  },
  {
    label: '2. Service Pricing',
    text: 'How much do a routine cleaning and in-office teeth whitening cost?',
  },
  {
    label: '3. Insurance & Booking Tool',
    text: 'Do you take Delta Dental PPO, and can you book me for Tuesday at 2 PM? My name is Jordan Lee, phone 555-234-9810.',
  },
  {
    label: '4. Out-of-Knowledge Guard',
    text: 'Do you sell electric toothbrushes or offer hair transplant consultations?',
  },
  {
    label: '5. Barge-In Test',
    text: 'Can you walk me through all of your dental services and prices in detail?',
  },
];

function formatTimer(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function DialerView({
  assistant,
  appointments,
  onSwitchMode,
  onToggleGreetFirst,
  onAppointmentCreated,
  onCallSaved,
  onNotify,
}: DialerViewProps) {
  const isNepaliAssistant = assistant.language.toLowerCase().startsWith('ne');
  const [countryCode, setCountryCode] = useState(isNepaliAssistant ? '+977' : '+1');
  const [phoneNumber, setPhoneNumber] = useState(
    assistant.phoneNumber || (isNepaliAssistant ? '1-555-0199' : '(555) 010-0199')
  );
  const [sttEngine, setSttEngine] = useState<'auto' | 'gemini'>('auto');
  const [callState, setCallState] = useState<CallState>('idle');
  const [elapsedSec, setElapsedSec] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [micPermissionError, setMicPermissionError] = useState<string | null>(null);
  const [transferBanner, setTransferBanner] = useState<string | null>(null);

  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [turnMetrics, setTurnMetrics] = useState<TurnMetrics[]>([]);
  const [debugOpen, setDebugOpen] = useState(true);
  const [demoScriptOpen, setDemoScriptOpen] = useState(true);
  const [textTurnInput, setTextTurnInput] = useState('');
  const [selectedMetricTurn, setSelectedMetricTurn] = useState<number | null>(null);
  const [micLevel, setMicLevel] = useState(0);
  const [voiceChannelStatus, setVoiceChannelStatus] = useState<string>('Standby');

  const sttEngineRef = useRef<'auto' | 'gemini'>('auto');
  useEffect(() => {
    sttEngineRef.current = sttEngine;
  }, [sttEngine]);

  // Refs for real-time audio & interruption safety
  const callStateRef = useRef<CallState>('idle');
  const isMutedRef = useRef(false);
  const assistantRef = useRef(assistant);
  const playerRef = useRef<PcmStreamPlayer | null>(null);
  const ringbackRef = useRef<RingbackTone | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const micAudioCtxRef = useRef<AudioContext | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const realtimeMicRef = useRef<RealtimeMicHandle | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const mediaRecorderStopRef = useRef<(() => void) | null>(null);

  const isAgentSpeakingRef = useRef(false);
  const activeTurnAbortRef = useRef<AbortController | null>(null);
  const activeAgentEntryIdRef = useRef<string | null>(null);
  const spokenSentencesRef = useRef<string[]>([]);
  const callStartTimeRef = useRef<string>('');
  const callAppointmentsRef = useRef<Appointment[]>([]);
  const callTransfersRef = useRef<Array<{ department: string; timestamp: string }>>([]);
  const transcriptRef = useRef<TranscriptEntry[]>([]);
  const turnMetricsRef = useRef<TurnMetrics[]>([]);
  const elapsedSecRef = useRef(0);

  // Pipeline STT endpointing refs
  const pendingFinalTextRef = useRef('');
  const lastSpeechStoppedAtRef = useRef(0);
  const endpointTimerRef = useRef<number | null>(null);
  const interimEntryIdRef = useRef<string | null>(null);
  const bargeInEnergyStartRef = useRef<number | null>(null);

  // Realtime mode turn tracking refs
  const rtUserEntryIdRef = useRef<string | null>(null);
  const rtAgentEntryIdRef = useRef<string | null>(null);
  const rtLastInputAtRef = useRef<number>(0);
  const rtFirstAudioRecordedRef = useRef(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    assistantRef.current = assistant;
    if (callStateRef.current === 'idle') {
      const isNp = assistant.language.toLowerCase().startsWith('ne');
      setCountryCode(isNp ? '+977' : '+1');
      setPhoneNumber(assistant.phoneNumber);
    }
  }, [assistant]);

  useEffect(() => {
    transcriptRef.current = transcript;
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcript]);

  useEffect(() => {
    turnMetricsRef.current = turnMetrics;
    if (turnMetrics.length > 0) {
      setSelectedMetricTurn(turnMetrics[turnMetrics.length - 1].turnIndex);
    }
  }, [turnMetrics]);

  useEffect(() => {
    isMutedRef.current = isMuted;
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getAudioTracks().forEach((track) => {
        track.enabled = !isMuted;
      });
    }
  }, [isMuted]);

  // Call duration timer
  useEffect(() => {
    if (callState !== 'connected') return;
    const id = window.setInterval(() => {
      setElapsedSec((prev) => {
        const next = prev + 1;
        elapsedSecRef.current = next;
        return next;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [callState]);

  // Waveform visualizer loop
  useEffect(() => {
    let rafId = 0;
    const freqData = new Uint8Array(64);

    const draw = () => {
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const w = canvas.width;
          const h = canvas.height;
          ctx.clearRect(0, 0, w, h);

          const activeAnalyser = isAgentSpeakingRef.current
            ? playerRef.current?.analyser
            : micAnalyserRef.current ?? realtimeMicRef.current?.analyser;

          const barCount = 32;
          const gap = 4;
          const barWidth = (w - gap * (barCount - 1)) / barCount;

          if (activeAnalyser && callStateRef.current === 'connected') {
            activeAnalyser.getByteFrequencyData(freqData);
          } else {
            freqData.fill(0);
          }

          for (let i = 0; i < barCount; i++) {
            const raw = activeAnalyser ? freqData[i % freqData.length] / 255 : 0;
            const ambient =
              callStateRef.current === 'ringing' || callStateRef.current === 'dialing'
                ? 0.14 + 0.08 * Math.sin(Date.now() * 0.006 + i * 0.4)
                : 0.08;
            const norm = Math.max(ambient, raw);
            const barH = Math.max(4, norm * (h - 8));
            const x = i * (barWidth + gap);
            const y = (h - barH) / 2;

            ctx.fillStyle = isAgentSpeakingRef.current
              ? 'rgba(52, 211, 153, 0.88)'
              : callStateRef.current === 'connected'
                ? 'rgba(56, 189, 248, 0.85)'
                : 'rgba(100, 116, 139, 0.35)';
            ctx.beginPath();
            ctx.roundRect(x, y, barWidth, barH, 2);
            ctx.fill();
          }
        }
      }
      rafId = requestAnimationFrame(draw);
    };

    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const appendTranscript = useCallback((entry: TranscriptEntry) => {
    setTranscript((prev) => [...prev, entry]);
  }, []);

  const handleBargeIn = useCallback(() => {
    if (!isAgentSpeakingRef.current && !activeTurnAbortRef.current) return;

    // 1. Abort in-flight LLM stream & TTS fetches
    if (activeTurnAbortRef.current) {
      activeTurnAbortRef.current.abort();
      activeTurnAbortRef.current = null;
    }

    // 2. Immediately stop audio playback and flush queued buffers
    playerRef.current?.flush();
    isAgentSpeakingRef.current = false;

    // 3. Truncate agent's transcript entry to what was actually spoken
    const targetId = activeAgentEntryIdRef.current;
    if (targetId) {
      const spoken = spokenSentencesRef.current.join(' ').trim();
      setTranscript((prev) =>
        prev
          .map((item) => {
            if (item.id !== targetId) return item;
            return {
              ...item,
              text: spoken || '(Interrupted before speaking)',
              interrupted: true,
              isInterim: false,
            };
          })
      );
      activeAgentEntryIdRef.current = null;
      spokenSentencesRef.current = [];
    }
  }, []);

  const executePipelineTurn = useCallback(
    async (userText: string, endpointingDelayMs: number, speechStoppedAt: number) => {
      const cleanUserText = userText.trim();
      if (!cleanUserText || callStateRef.current !== 'connected') return;

      // Interrupt any active response if user triggered a new turn
      if (isAgentSpeakingRef.current || activeTurnAbortRef.current) {
        handleBargeIn();
      }

      const currentAssistant = assistantRef.current;
      const turnIndex = turnMetricsRef.current.length + 1;

      const userEntryId = `u-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
      appendTranscript({
        id: userEntryId,
        role: 'user',
        text: cleanUserText,
        timestamp: new Date().toISOString(),
      });

      const agentEntryId = `a-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
      activeAgentEntryIdRef.current = agentEntryId;
      spokenSentencesRef.current = [];
      appendTranscript({
        id: agentEntryId,
        role: 'agent',
        text: '...',
        isInterim: true,
        timestamp: new Date().toISOString(),
      });

      const abortController = new AbortController();
      activeTurnAbortRef.current = abortController;

      const historySnapshot = transcriptRef.current
        .filter((t) => !t.isInterim && t.role !== 'system' && t.id !== userEntryId)
        .slice(-10)
        .map((t) => ({ role: t.role as 'user' | 'agent', text: t.text }));

      const prevAgentTurn = [...historySnapshot]
        .reverse()
        .find((h) => h.role === 'agent')?.text;

      let retrievalMs = 0;
      let chunksUsed: SearchChunkResult[] = [];
      let contextStrategy: 'rag' | 'stuffed' = 'rag';
      let llmTtftMs = 0;
      let ttsTtfaMs = 0;
      let firstAudioStartRecorded = false;
      let totalLatencyMs = 0;
      let shouldAutoHangup = false;

      // Ordered TTS prefetch chain: fetches start immediately per sentence, playback runs strictly sequentially
      interface TtsJob {
        sentence: string;
        promise: Promise<{ audio?: string; sampleRate: number; ttfaMs: number }>;
      }
      const ttsQueue: TtsJob[] = [];
      let isConsumingQueue = false;
      let streamFinished = false;

      const recordMetricsIfDone = () => {
        if (!firstAudioStartRecorded) return;
        const metric: TurnMetrics = {
          turnIndex,
          mode: 'pipeline',
          userText: cleanUserText,
          endpointingDelayMs,
          retrievalMs,
          llmTtftMs,
          ttsTtfaMs,
          totalLatencyMs,
          chunksUsed,
          contextStrategy,
          timestamp: new Date().toISOString(),
        };
        setTurnMetrics((prev) => {
          const exists = prev.some((p) => p.turnIndex === turnIndex);
          if (exists) {
            return prev.map((p) => (p.turnIndex === turnIndex ? metric : p));
          }
          return [...prev, metric];
        });
      };

      const consumeTtsQueue = async () => {
        if (isConsumingQueue) return;
        isConsumingQueue = true;
        try {
          while (ttsQueue.length > 0 && !abortController.signal.aborted) {
            const job = ttsQueue.shift()!;
            const res = await job.promise;
            if (abortController.signal.aborted) break;

            if (ttsTtfaMs === 0 && res.ttfaMs > 0) {
              ttsTtfaMs = res.ttfaMs;
            }

            if (res.audio && playerRef.current) {
              isAgentSpeakingRef.current = true;
              playerRef.current.enqueuePcmBase64(
                res.audio,
                {
                  onStart: () => {
                    if (abortController.signal.aborted) return;
                    if (!firstAudioStartRecorded) {
                      firstAudioStartRecorded = true;
                      totalLatencyMs = Math.max(
                        1,
                        Math.round(performance.now() - speechStoppedAt)
                      );
                      recordMetricsIfDone();
                    }
                    spokenSentencesRef.current.push(job.sentence);
                  },
                  onEnded: () => {
                    if (!playerRef.current?.isPlaying && ttsQueue.length === 0 && streamFinished) {
                      isAgentSpeakingRef.current = false;
                      if (shouldAutoHangup && callStateRef.current === 'connected') {
                        window.setTimeout(() => {
                          void endCallRef.current?.();
                        }, 350);
                      }
                    }
                  },
                },
                res.sampleRate
              );
            }
          }
        } catch (err) {
          if ((err as Error)?.name !== 'AbortError') {
            onNotify(
              'error',
              'TTS playback error',
              err instanceof Error ? err.message : 'Unable to synthesize speech.'
            );
          }
        } finally {
          isConsumingQueue = false;
          if (streamFinished && ttsQueue.length === 0 && !playerRef.current?.isPlaying) {
            isAgentSpeakingRef.current = false;
          }
        }
      };

      const enqueueSentenceForTts = (sentence: string) => {
        const clean = sentence.trim();
        if (!clean || abortController.signal.aborted) return;

        const ttsPromise = fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: abortController.signal,
          body: JSON.stringify({
            text: clean,
            voiceName: currentAssistant.voice,
            styleInstruction: currentAssistant.styleInstruction,
          }),
        }).then(async (r) => {
          const data = (await r.json()) as {
            audio?: string;
            sampleRate?: number;
            ttfaMs?: number;
            error?: string;
          };
          if (!r.ok) throw new Error(data.error || 'TTS failed');
          return {
            audio: data.audio,
            sampleRate: data.sampleRate ?? 24000,
            ttfaMs: data.ttfaMs ?? 0,
          };
        });

        ttsQueue.push({ sentence: clean, promise: ttsPromise });
        void consumeTtsQueue();
      };

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: abortController.signal,
          body: JSON.stringify({
            assistantId: currentAssistant.id,
            message: cleanUserText,
            previousTurnContext: prevAgentTurn ? `Agent: ${prevAgentTurn}` : '',
            history: historySnapshot,
          }),
        });

        if (!response.ok || !response.body) {
          const errJson = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(errJson.error || `Chat request failed (${response.status})`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = '';
        let llmTextBuffer = '';
        let fullAgentText = '';

        const processSseBlock = (block: string) => {
          const lines = block.split('\n');
          let eventName = 'message';
          let dataRaw = '';
          for (const line of lines) {
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            if (line.startsWith('data:')) dataRaw += line.slice(5).trim();
          }
          if (!dataRaw) return;
          const payload = JSON.parse(dataRaw) as Record<string, unknown>;

          if (eventName === 'meta') {
            retrievalMs = Number(payload.retrievalMs ?? 0);
            chunksUsed = (payload.chunksUsed as SearchChunkResult[]) ?? [];
            contextStrategy = (payload.contextStrategy as 'rag' | 'stuffed') ?? 'rag';
          } else if (eventName === 'token') {
            const delta = String(payload.text ?? '');
            if (llmTtftMs === 0 && payload.ttftMs) {
              llmTtftMs = Number(payload.ttftMs);
            }
            fullAgentText += delta;
            llmTextBuffer += delta;

            setTranscript((prev) =>
              prev.map((item) =>
                item.id === agentEntryId
                  ? { ...item, text: fullAgentText, isInterim: false }
                  : item
              )
            );

            const { sentences, remainder } = extractCompleteSentences(llmTextBuffer);
            llmTextBuffer = remainder;
            for (const s of sentences) {
              enqueueSentenceForTts(s);
            }
          } else if (eventName === 'tool') {
            const toolName = String(payload.name ?? '');
            const args = (payload.args ?? {}) as Record<string, unknown>;
            const result = (payload.result ?? {}) as Record<string, unknown>;

            if (toolName === 'book_appointment' && result.appointment) {
              const appt = result.appointment as Appointment;
              callAppointmentsRef.current.push(appt);
              onAppointmentCreated(appt);
              onNotify('success', 'Appointment booked', `${appt.name} · ${appt.datetime}`);
            } else if (toolName === 'transfer_to_human') {
              const dept = String(args.department ?? 'Front Desk');
              callTransfersRef.current.push({
                department: dept,
                timestamp: new Date().toISOString(),
              });
              setTransferBanner(`Transferring call to ${dept} specialist`);
              onNotify('info', `Transfer initiated`, `Connecting to ${dept}`);
            }

            appendTranscript({
              id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
              role: 'system',
              text:
                toolName === 'book_appointment'
                  ? `Booked appointment for ${String(args.name ?? 'caller')} (${String(args.datetime ?? '')})`
                  : toolName === 'transfer_to_human'
                    ? `Transferred to ${String(args.department ?? 'Front Desk')}`
                    : `Call end requested (${String(args.reason ?? 'completed')})`,
              timestamp: new Date().toISOString(),
              toolEvent: { name: toolName, args, result },
            });
          } else if (eventName === 'end_call') {
            shouldAutoHangup = true;
          } else if (eventName === 'error') {
            throw new Error(String(payload.message ?? 'LLM stream error'));
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          sseBuffer += decoder.decode(value, { stream: true });
          let sepIdx = sseBuffer.indexOf('\n\n');
          while (sepIdx !== -1) {
            const block = sseBuffer.slice(0, sepIdx);
            sseBuffer = sseBuffer.slice(sepIdx + 2);
            if (block.trim()) processSseBlock(block);
            sepIdx = sseBuffer.indexOf('\n\n');
          }
        }

        if (llmTextBuffer.trim() && !abortController.signal.aborted) {
          enqueueSentenceForTts(llmTextBuffer.trim());
        }
        streamFinished = true;
        if (!firstAudioStartRecorded && !abortController.signal.aborted) {
          // Ensure metrics still appear if only tool/text happened
          totalLatencyMs = Math.max(1, Math.round(performance.now() - speechStoppedAt));
          firstAudioStartRecorded = true;
          recordMetricsIfDone();
        }
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
        const msg = err instanceof Error ? err.message : 'Pipeline turn failed.';
        onNotify('error', 'Assistant response error', msg);
        setTranscript((prev) =>
          prev.map((item) =>
            item.id === agentEntryId
              ? { ...item, text: `Error: ${msg}`, isInterim: false }
              : item
          )
        );
      } finally {
        if (activeTurnAbortRef.current === abortController) {
          activeTurnAbortRef.current = null;
        }
      }
    },
    [appendTranscript, handleBargeIn, onAppointmentCreated, onNotify]
  );

  // Cleanup everything on call end
  const cleanupCallResources = useCallback(() => {
    if (endpointTimerRef.current !== null) {
      window.clearTimeout(endpointTimerRef.current);
      endpointTimerRef.current = null;
    }
    activeTurnAbortRef.current?.abort();
    activeTurnAbortRef.current = null;

    ringbackRef.current?.stop();
    playerRef.current?.flush();
    isAgentSpeakingRef.current = false;

    if (recognitionRef.current) {
      try {
        recognitionRef.current.onend = null;
        recognitionRef.current.onresult = null;
        recognitionRef.current.abort();
      } catch {
        // ignore
      }
      recognitionRef.current = null;
    }

    if (mediaRecorderStopRef.current) {
      mediaRecorderStopRef.current();
      mediaRecorderStopRef.current = null;
    }

    if (realtimeMicRef.current) {
      realtimeMicRef.current.stop();
      realtimeMicRef.current = null;
    }

    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {
        // ignore
      }
      wsRef.current = null;
    }

    if (micAudioCtxRef.current && micAudioCtxRef.current.state !== 'closed') {
      void micAudioCtxRef.current.close().catch(() => {});
    }
    micAudioCtxRef.current = null;
    micAnalyserRef.current = null;

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    setMicLevel(0);
    setVoiceChannelStatus('Standby');
  }, []);

  const endCallRef = useRef<(() => Promise<void>) | null>(null);

  const handleEndCall = useCallback(async () => {
    if (callStateRef.current === 'idle' || callStateRef.current === 'ended') return;
    const wasConnected = callStateRef.current === 'connected';
    callStateRef.current = 'ended';
    setCallState('ended');
    cleanupCallResources();

    if (wasConnected && transcriptRef.current.length > 0) {
      try {
        const res = await fetch('/api/calls', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            assistantId: assistantRef.current.id,
            assistantName: `${assistantRef.current.name} - ${assistantRef.current.companyName}`,
            phoneNumber: `${countryCode} ${phoneNumber}`.trim(),
            mode: assistantRef.current.mode,
            durationSec: elapsedSecRef.current,
            startedAt: callStartTimeRef.current || new Date().toISOString(),
            endedAt: new Date().toISOString(),
            transcript: transcriptRef.current,
            turnMetrics: turnMetricsRef.current,
            appointmentsBooked: callAppointmentsRef.current,
            transfers: callTransfersRef.current,
          }),
        });
        const data = (await res.json()) as { call?: CallLog };
        if (res.ok && data.call) {
          onCallSaved(data.call);
          onNotify('info', 'Call saved to Call Logs', data.call.outcome);
        }
      } catch {
        onNotify('error', 'Could not save call log');
      }
    }
  }, [cleanupCallResources, countryCode, onCallSaved, onNotify, phoneNumber]);

  useEffect(() => {
    endCallRef.current = handleEndCall;
  }, [handleEndCall]);

  useEffect(() => {
    return () => {
      cleanupCallResources();
      playerRef.current?.close();
    };
  }, [cleanupCallResources]);

  const startPipelineSpeechCapture = useCallback(
    (stream: MediaStream) => {
      let onSilentSpeechFallback: (() => void) | null = null;

      // Set up mic analyser for waveform + mic level meter + energy-based barge-in
      try {
        const micCtx = new AudioContext();
        micAudioCtxRef.current = micCtx;
        if (micCtx.state === 'suspended') {
          void micCtx.resume().catch(() => {});
        }
        const src = micCtx.createMediaStreamSource(stream);
        const analyser = micCtx.createAnalyser();
        analyser.fftSize = 256;
        src.connect(analyser);
        micAnalyserRef.current = analyser;

        const timeData = new Float32Array(analyser.fftSize);
        let lastLevelUpdate = 0;
        let lastFrameAt = performance.now();
        let activeSpeechEnergyMs = 0;

        const monitorEnergy = () => {
          if (callStateRef.current !== 'connected') return;
          analyser.getFloatTimeDomainData(timeData);
          let sum = 0;
          for (let i = 0; i < timeData.length; i++) {
            sum += timeData[i] * timeData[i];
          }
          const rms = Math.sqrt(sum / timeData.length);
          const now = performance.now();
          const dt = Math.min(100, now - lastFrameAt);
          lastFrameAt = now;

          if (now - lastLevelUpdate > 90) {
            lastLevelUpdate = now;
            setMicLevel(isMutedRef.current ? 0 : Math.min(100, Math.round(rms * 450)));
          }

          if (!isMutedRef.current && !isAgentSpeakingRef.current && rms > 0.025) {
            activeSpeechEnergyMs += dt;
            if (activeSpeechEnergyMs > 1500 && onSilentSpeechFallback) {
              const cb = onSilentSpeechFallback;
              onSilentSpeechFallback = null;
              cb();
            }
          }

          if (!isMutedRef.current && isAgentSpeakingRef.current) {
            if (rms > 0.06) {
              if (bargeInEnergyStartRef.current === null) {
                bargeInEnergyStartRef.current = now;
              } else if (now - bargeInEnergyStartRef.current > 180) {
                bargeInEnergyStartRef.current = null;
                handleBargeIn();
              }
            } else {
              bargeInEnergyStartRef.current = null;
            }
          } else {
            bargeInEnergyStartRef.current = null;
          }
          requestAnimationFrame(monitorEnergy);
        };
        requestAnimationFrame(monitorEnergy);
      } catch {
        // ignore mic analyser error
      }

      const activateMediaRecorderFallback = (reasonNote?: string) => {
        if (mediaRecorderStopRef.current || callStateRef.current !== 'connected') return;
        if (typeof MediaRecorder === 'undefined') {
          setVoiceChannelStatus('Text input only (no STT available)');
          return;
        }
        setVoiceChannelStatus('Listening (Gemini Audio STT)');
        if (reasonNote) {
          onNotify('info', 'Switched to Gemini Audio STT', reasonNote);
        }

        let stopped = false;
        let recorder: MediaRecorder | null = null;
        let chunks: Blob[] = [];
        let speaking = false;
        let silenceStart: number | null = null;
        const analyser = micAnalyserRef.current;
        const buf = analyser ? new Float32Array(analyser.fftSize) : null;

        const mimeType = MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : 'audio/mp4';

        const startSegment = () => {
          if (stopped) return;
          chunks = [];
          recorder = new MediaRecorder(stream, { mimeType });
          recorder.ondataavailable = (e) => {
            if (e.data.size > 0) chunks.push(e.data);
          };
          recorder.onstop = async () => {
            const blob = new Blob(chunks, { type: mimeType });
            if (blob.size < 1400 || stopped) return;
            const speechEndedAt = performance.now();
            setVoiceChannelStatus('Transcribing speech...');
            const arrBuf = await blob.arrayBuffer();
            const bytes = new Uint8Array(arrBuf);
            let binary = '';
            for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);

            try {
              const r = await fetch('/api/stt', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  audioBase64: btoa(binary),
                  mimeType,
                  language: assistantRef.current.language,
                }),
              });
              const d = (await r.json()) as { text?: string; error?: string };
              if (d.text?.trim()) {
                const delay = Math.round(performance.now() - speechEndedAt);
                void executePipelineTurn(d.text.trim(), delay, speechEndedAt);
              }
            } catch {
              // ignore transient STT error
            } finally {
              if (!stopped && callStateRef.current === 'connected') {
                setVoiceChannelStatus('Listening (Gemini Audio STT)');
              }
            }
          };
          recorder.start();
        };

        const tick = () => {
          if (stopped || callStateRef.current !== 'connected') return;
          if (analyser && buf && !isMutedRef.current) {
            analyser.getFloatTimeDomainData(buf);
            let sum = 0;
            for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
            const rms = Math.sqrt(sum / buf.length);

            if (rms > 0.018) {
              silenceStart = null;
              if (!speaking) {
                speaking = true;
                setVoiceChannelStatus('Recording speech...');
                if (isAgentSpeakingRef.current) handleBargeIn();
                startSegment();
              }
            } else if (speaking) {
              if (silenceStart === null) silenceStart = performance.now();
              else if (performance.now() - silenceStart > 700) {
                speaking = false;
                silenceStart = null;
                recorder?.stop();
              }
            }
          }
          window.setTimeout(tick, 90);
        };
        window.setTimeout(tick, 90);
        mediaRecorderStopRef.current = () => {
          stopped = true;
          try {
            if (recorder && recorder.state !== 'inactive') recorder.stop();
          } catch {
            // ignore
          }
        };
      };

      const SpeechRecCtor =
        (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike })
          .SpeechRecognition ||
        (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike })
          .webkitSpeechRecognition;

      if (sttEngineRef.current !== 'gemini' && SpeechRecCtor) {
        const rec = new SpeechRecCtor();
        rec.continuous = true;
        rec.interimResults = true;
        rec.lang = assistantRef.current.language || 'en-US';
        recognitionRef.current = rec;
        let receivedAnySpeechResult = false;
        let switchedToFallback = false;

        onSilentSpeechFallback = () => {
          if (receivedAnySpeechResult || switchedToFallback) return;
          switchedToFallback = true;
          recognitionRef.current = null;
          try {
            rec.abort();
          } catch {
            // ignore
          }
          activateMediaRecorderFallback(
            'Web Speech returned no transcript; switched to Gemini Audio STT.'
          );
        };

        const scheduleEndpoint = () => {
          if (endpointTimerRef.current !== null) {
            window.clearTimeout(endpointTimerRef.current);
          }
          endpointTimerRef.current = window.setTimeout(() => {
            const text = pendingFinalTextRef.current.trim();
            if (!text) return;
            const delayMs = Math.max(
              50,
              Math.round(performance.now() - lastSpeechStoppedAtRef.current)
            );
            pendingFinalTextRef.current = '';
            if (interimEntryIdRef.current) {
              const removeId = interimEntryIdRef.current;
              interimEntryIdRef.current = null;
              setTranscript((prev) => prev.filter((item) => item.id !== removeId));
            }
            void executePipelineTurn(text, delayMs, lastSpeechStoppedAtRef.current);
          }, 700);
        };

        rec.onresult = (event) => {
          if (isMutedRef.current || callStateRef.current !== 'connected') return;
          receivedAnySpeechResult = true;
          let interimText = '';
          let addedFinal = false;

          for (let i = event.resultIndex; i < event.results.length; i++) {
            const res = event.results[i];
            const text = res[0]?.transcript ?? '';
            if (res.isFinal) {
              pendingFinalTextRef.current = `${pendingFinalTextRef.current} ${text}`.trim();
              addedFinal = true;
            } else {
              interimText += text;
            }
          }

          if ((interimText.trim().length >= 2 || addedFinal) && isAgentSpeakingRef.current) {
            handleBargeIn();
          }

          lastSpeechStoppedAtRef.current = performance.now();

          const displayInterim = [pendingFinalTextRef.current, interimText.trim()]
            .filter(Boolean)
            .join(' ');

          if (displayInterim) {
            if (!interimEntryIdRef.current) {
              const id = `interim-${Date.now()}`;
              interimEntryIdRef.current = id;
              appendTranscript({
                id,
                role: 'user',
                text: displayInterim,
                isInterim: true,
                timestamp: new Date().toISOString(),
              });
            } else {
              const id = interimEntryIdRef.current;
              setTranscript((prev) =>
                prev.map((item) => (item.id === id ? { ...item, text: displayInterim } : item))
              );
            }
          }

          if (pendingFinalTextRef.current.trim()) {
            scheduleEndpoint();
          }
        };

        rec.onerror = (ev) => {
          const errCode = ev.error || 'unknown';
          if (
            !switchedToFallback &&
            ['not-allowed', 'service-not-allowed', 'audio-capture', 'network'].includes(errCode)
          ) {
            switchedToFallback = true;
            recognitionRef.current = null;
            try {
              rec.abort();
            } catch {
              // ignore
            }
            activateMediaRecorderFallback(`Browser SpeechRecognition (${errCode}) unavailable.`);
          }
        };

        rec.onend = () => {
          if (switchedToFallback) return;
          if (callStateRef.current === 'connected' && recognitionRef.current === rec) {
            try {
              rec.start();
            } catch {
              if (!receivedAnySpeechResult) {
                switchedToFallback = true;
                recognitionRef.current = null;
                activateMediaRecorderFallback();
              }
            }
          }
        };

        try {
          rec.start();
          setVoiceChannelStatus('Listening (Web Speech)');
          return;
        } catch {
          recognitionRef.current = null;
        }
      }

      activateMediaRecorderFallback();
    },
    [appendTranscript, executePipelineTurn, handleBargeIn, onNotify]
  );

  const startRealtimeSession = useCallback(
    async (stream: MediaStream | null) => {
      setVoiceChannelStatus('Connecting Fedora Pilot...');
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${window.location.host}/api/live`);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: 'start',
            assistantId: assistantRef.current.id,
          })
        );
      };

      ws.onmessage = async (event) => {
        const msg = JSON.parse(event.data as string) as {
          type: string;
          model?: string;
          reason?: string;
          data?: string;
          text?: string;
          name?: string;
          args?: Record<string, unknown>;
          result?: Record<string, unknown>;
          message?: string;
        };

        if (msg.type === 'ready') {
          setVoiceChannelStatus(
            stream ? `Live Connected (${msg.model || 'Fedora Pilot'})` : 'Live Connected (Text Only)'
          );
          if (stream) {
            try {
              const handle = await startRealtimeMicWorklet(stream, (base64Pcm) => {
                if (!isMutedRef.current && ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'audio', data: base64Pcm }));
                }
              });
              realtimeMicRef.current = handle;

              // Drive handset mic input meter from Live AudioWorklet analyser
              const timeData = new Float32Array(handle.analyser.fftSize);
              let lastMeterAt = 0;
              const sampleMeter = () => {
                if (callStateRef.current !== 'connected' || !realtimeMicRef.current) return;
                const now = performance.now();
                if (now - lastMeterAt > 90) {
                  lastMeterAt = now;
                  handle.analyser.getFloatTimeDomainData(timeData);
                  let sum = 0;
                  for (let i = 0; i < timeData.length; i++) sum += timeData[i] * timeData[i];
                  const rms = Math.sqrt(sum / timeData.length);
                  setMicLevel(isMutedRef.current ? 0 : Math.min(100, Math.round(rms * 450)));
                }
                requestAnimationFrame(sampleMeter);
              };
              requestAnimationFrame(sampleMeter);
            } catch (err) {
              setVoiceChannelStatus('Mic capture failed');
              onNotify(
                'error',
                'Live Mic Capture Failed',
                err instanceof Error ? err.message : 'Unable to start 16kHz mic capture.'
              );
            }
          }
          return;
        }

        if (msg.type === 'inputTranscript' && msg.text) {
          rtLastInputAtRef.current = performance.now();
          rtFirstAudioRecordedRef.current = false;
          if (!rtUserEntryIdRef.current) {
            const id = `rt-u-${Date.now()}`;
            rtUserEntryIdRef.current = id;
            appendTranscript({
              id,
              role: 'user',
              text: msg.text,
              timestamp: new Date().toISOString(),
            });
          } else {
            const id = rtUserEntryIdRef.current;
            setTranscript((prev) =>
              prev.map((item) =>
                item.id === id ? { ...item, text: `${item.text} ${msg.text}`.trim() } : item
              )
            );
          }
          return;
        }

        if (msg.type === 'outputTranscript' && msg.text) {
          rtUserEntryIdRef.current = null;
          if (!rtAgentEntryIdRef.current) {
            const id = `rt-a-${Date.now()}`;
            rtAgentEntryIdRef.current = id;
            appendTranscript({
              id,
              role: 'agent',
              text: msg.text,
              timestamp: new Date().toISOString(),
            });
          } else {
            const id = rtAgentEntryIdRef.current;
            setTranscript((prev) =>
              prev.map((item) =>
                item.id === id ? { ...item, text: `${item.text}${msg.text}` } : item
              )
            );
          }
          return;
        }

        if (msg.type === 'audio' && msg.data && playerRef.current) {
          if (!rtFirstAudioRecordedRef.current && rtLastInputAtRef.current > 0) {
            rtFirstAudioRecordedRef.current = true;
            const totalLatencyMs = Math.max(
              1,
              Math.round(performance.now() - rtLastInputAtRef.current)
            );
            const userPromptText =
              transcriptRef.current.find((t) => t.id === rtUserEntryIdRef.current)?.text ||
              '(Voice turn)';
            setTurnMetrics((prev) => [
              ...prev,
              {
                turnIndex: prev.length + 1,
                mode: 'realtime',
                userText: userPromptText,
                endpointingDelayMs: 0,
                retrievalMs: 0,
                llmTtftMs: totalLatencyMs,
                ttsTtfaMs: totalLatencyMs,
                totalLatencyMs,
                chunksUsed: [],
                contextStrategy: 'stuffed',
                timestamp: new Date().toISOString(),
              },
            ]);
          }

          isAgentSpeakingRef.current = true;
          playerRef.current.enqueuePcmBase64(msg.data, {
            onEnded: () => {
              if (!playerRef.current?.isPlaying) {
                isAgentSpeakingRef.current = false;
              }
            },
          });
          return;
        }

        if (msg.type === 'interrupted') {
          playerRef.current?.flush();
          isAgentSpeakingRef.current = false;
          if (rtAgentEntryIdRef.current) {
            const id = rtAgentEntryIdRef.current;
            setTranscript((prev) =>
              prev.map((item) => (item.id === id ? { ...item, interrupted: true } : item))
            );
            rtAgentEntryIdRef.current = null;
          }
          return;
        }

        if (msg.type === 'turnComplete') {
          rtUserEntryIdRef.current = null;
          rtAgentEntryIdRef.current = null;
          return;
        }

        if (msg.type === 'tool') {
          const toolName = msg.name ?? '';
          const args = msg.args ?? {};
          const result = msg.result ?? {};
          if (toolName === 'book_appointment' && result.appointment) {
            const appt = result.appointment as Appointment;
            callAppointmentsRef.current.push(appt);
            onAppointmentCreated(appt);
            onNotify('success', 'Appointment booked', `${appt.name} · ${appt.datetime}`);
          } else if (toolName === 'transfer_to_human') {
            const dept = String(args.department ?? 'Front Desk');
            callTransfersRef.current.push({
              department: dept,
              timestamp: new Date().toISOString(),
            });
            setTransferBanner(`Transferring call to ${dept} specialist`);
            onNotify('info', 'Transfer initiated', `Connecting to ${dept}`);
          } else if (toolName === 'end_call') {
            window.setTimeout(() => {
              void endCallRef.current?.();
            }, 1200);
          }

          appendTranscript({
            id: `rt-sys-${Date.now()}`,
            role: 'system',
            text:
              toolName === 'book_appointment'
                ? `Booked appointment for ${String(args.name ?? 'caller')} (${String(args.datetime ?? '')})`
                : toolName === 'transfer_to_human'
                  ? `Transferred to ${String(args.department ?? 'Front Desk')}`
                  : `Call end requested (${String(args.reason ?? 'completed')})`,
            timestamp: new Date().toISOString(),
          });
          return;
        }

        if (msg.type === 'error') {
          setVoiceChannelStatus('Live Error');
          onNotify('error', 'Fedora Pilot error', msg.message || 'Connection issue');
          return;
        }

        if (msg.type === 'closed') {
          setVoiceChannelStatus(
            msg.reason ? `Live closed: ${msg.reason}` : 'Live session closed'
          );
        }
      };

      ws.onerror = () => {
        setVoiceChannelStatus('WebSocket Error');
        onNotify('error', 'WebSocket connection failed', 'Unable to reach /api/live.');
      };
    },
    [appendTranscript, onAppointmentCreated, onNotify]
  );

  const handleDial = async () => {
    if (callStateRef.current !== 'idle' && callStateRef.current !== 'ended') return;

    setTranscript([]);
    setTurnMetrics([]);
    setElapsedSec(0);
    elapsedSecRef.current = 0;
    setMicPermissionError(null);
    setTransferBanner(null);
    callAppointmentsRef.current = [];
    callTransfersRef.current = [];
    callStartTimeRef.current = new Date().toISOString();

    if (!playerRef.current) {
      playerRef.current = new PcmStreamPlayer();
    }
    playerRef.current.ensureContext();

    callStateRef.current = 'dialing';
    setCallState('dialing');

    // Start ringback tone
    if (!ringbackRef.current) {
      ringbackRef.current = new RingbackTone();
    }
    ringbackRef.current.start();

    // Pre-cache first message TTS immediately while dialing/ringing ONLY when greetFirst is enabled
    const activeAst = assistantRef.current;
    const shouldGreetFirst = activeAst.greetFirst !== false;
    const greeting = shouldGreetFirst ? activeAst.firstMessage.trim() : '';
    const greetingPromise = greeting
      ? fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: greeting,
            voiceName: activeAst.voice,
            styleInstruction: activeAst.styleInstruction,
          }),
        })
          .then(async (r) => {
            const json = (await r.json()) as {
              audio?: string;
              sampleRate?: number;
              error?: string;
            };
            if (!r.ok) {
              throw new Error(json.error || `Greeting TTS failed (${r.status})`);
            }
            return json;
          })
          .catch((err) => {
            onNotify(
              'error',
              'Greeting voice failed',
              err instanceof Error ? err.message : 'Could not synthesize greeting.'
            );
            return null;
          })
      : Promise.resolve(null);

    // Request mic access with Echo Cancellation, Noise Suppression, Auto Gain Control
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      mediaStreamRef.current = stream;
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Microphone permission denied. You can still type caller prompts below.';
      setMicPermissionError(msg);
      setVoiceChannelStatus('Mic Blocked (Text Fallback)');
      onNotify('info', 'Microphone unavailable', 'Text fallback remains active during the call.');
    }

    if (callStateRef.current !== 'dialing') {
      ringbackRef.current.stop();
      stream?.getTracks().forEach((t) => t.stop());
      return;
    }

    window.setTimeout(() => {
      if (callStateRef.current !== 'dialing') return;
      callStateRef.current = 'ringing';
      setCallState('ringing');
    }, 650);

    window.setTimeout(async () => {
      if (callStateRef.current !== 'ringing' && callStateRef.current !== 'dialing') return;
      ringbackRef.current?.stop();
      callStateRef.current = 'connected';
      setCallState('connected');

      // Start mic/live session immediately on connect
      if (assistantRef.current.mode === 'realtime') {
        void startRealtimeSession(stream);
      } else if (stream) {
        startPipelineSpeechCapture(stream);
      }

      // Play pre-cached greeting strictly after ringing ends, when AI greet-first is enabled
      if (shouldGreetFirst && greeting) {
        const cachedGreeting = await greetingPromise;
        if (callStateRef.current !== 'connected') return;

        const greetId = `greet-${Date.now()}`;
        activeAgentEntryIdRef.current = greetId;
        spokenSentencesRef.current = [greeting];
        appendTranscript({
          id: greetId,
          role: 'agent',
          text: greeting,
          timestamp: new Date().toISOString(),
        });

        if (cachedGreeting?.audio && playerRef.current) {
          isAgentSpeakingRef.current = true;
          playerRef.current.enqueuePcmBase64(
            cachedGreeting.audio,
            {
              onEnded: () => {
                if (!playerRef.current?.isPlaying) {
                  isAgentSpeakingRef.current = false;
                  activeAgentEntryIdRef.current = null;
                }
              },
            },
            cachedGreeting.sampleRate ?? 24000
          );
        }
      }
    }, 2000);
  };

  const handleSubmitTextTurn = (textOverride?: string) => {
    const text = (textOverride ?? textTurnInput).trim();
    if (!text || callStateRef.current !== 'connected') return;
    if (!textOverride) setTextTurnInput('');

    if (assistant.mode === 'realtime') {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        if (isAgentSpeakingRef.current) {
          playerRef.current?.flush();
          isAgentSpeakingRef.current = false;
        }
        rtLastInputAtRef.current = performance.now();
        rtFirstAudioRecordedRef.current = false;
        const id = `rt-u-${Date.now()}`;
        rtUserEntryIdRef.current = id;
        appendTranscript({
          id,
          role: 'user',
          text,
          timestamp: new Date().toISOString(),
        });
        wsRef.current.send(JSON.stringify({ type: 'text', text }));
      }
      return;
    }

    void executePipelineTurn(text, 0, performance.now());
  };

  const handleKeypadPress = (digit: string) => {
    playDtmfDigit(digit);
    if (callState === 'idle' || callState === 'ended') {
      setPhoneNumber((prev) => `${prev}${digit}`);
    }
  };

  const activeMetric =
    turnMetrics.find((m) => m.turnIndex === selectedMetricTurn) ??
    turnMetrics[turnMetrics.length - 1] ??
    null;

  const isCallActive =
    callState === 'dialing' || callState === 'ringing' || callState === 'connected';

  return (
    <div className="max-w-7xl mx-auto p-6 lg:p-8 space-y-6">
      {/* Top Toolbar */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 pb-5 border-b border-slate-800/80">
        <div>
          <h1 className="text-2xl font-display font-semibold text-slate-100">
            Voice Dialer
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Any dialed number routes to{' '}
            <span className="text-slate-100 font-medium">
              {assistant.name} ({assistant.companyName})
            </span>{' '}
            using voice <span className="font-mono text-sky-400">{assistant.voice}</span>.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Quick Mode Switcher */}
          <div className="inline-flex p-1 rounded-lg bg-[#111827] border border-slate-800">
            <button
              type="button"
              disabled={isCallActive}
              onClick={() => onSwitchMode('pipeline')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer disabled:opacity-60 whitespace-nowrap ${
                assistant.mode === 'pipeline'
                  ? 'bg-sky-500 text-slate-950 font-semibold'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              Pipeline Mode
            </button>
            <button
              type="button"
              disabled={isCallActive}
              onClick={() => onSwitchMode('realtime')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer disabled:opacity-60 whitespace-nowrap ${
                assistant.mode === 'realtime'
                  ? 'bg-sky-500 text-slate-950 font-semibold'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              Realtime (Live)
            </button>
          </div>

          {assistant.mode === 'pipeline' && (
            <button
              type="button"
              disabled={isCallActive}
              onClick={() =>
                setSttEngine((prev) => (prev === 'auto' ? 'gemini' : 'auto'))
              }
              title="Toggle between Browser Web Speech (with auto fallback) and direct Gemini Audio STT (recommended if Nepali Web Speech is unavailable)"
              className={`px-3 py-2 rounded-lg border text-xs font-medium transition-colors cursor-pointer disabled:opacity-60 whitespace-nowrap ${
                sttEngine === 'gemini'
                  ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300'
                  : 'border-slate-800 bg-[#111827] text-slate-300 hover:text-white'
              }`}
            >
              {sttEngine === 'gemini' ? 'STT: Gemini Audio' : 'STT: Web Speech (Auto)'}
            </button>
          )}

          <button
            type="button"
            disabled={isCallActive}
            onClick={onToggleGreetFirst}
            title="Enable or disable whether the AI greets immediately after ringing ends"
            className={`px-3 py-2 rounded-lg border text-xs font-medium transition-colors cursor-pointer disabled:opacity-60 whitespace-nowrap ${
              assistant.greetFirst !== false
                ? 'border-sky-500/50 bg-sky-500/10 text-sky-300'
                : 'border-slate-800 bg-[#111827] text-slate-400 hover:text-white'
            }`}
          >
            {assistant.greetFirst !== false ? 'Greet First: On' : 'Greet First: Off'}
          </button>

          <button
            type="button"
            onClick={() => setDebugOpen((v) => !v)}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
              debugOpen
                ? 'border-sky-500/50 bg-sky-500/10 text-sky-300'
                : 'border-slate-800 bg-[#111827] text-slate-300 hover:text-white'
            }`}
          >
            <PanelRightOpen className="w-3.5 h-3.5" />
            <span>{debugOpen ? 'Hide Debug Drawer' : 'Debug Drawer'}</span>
          </button>
        </div>
      </div>

      {/* Transfer Banner */}
      {transferBanner && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          <div className="flex items-center gap-2.5">
            <PhoneForwarded className="w-4 h-4 text-amber-400 shrink-0" />
            <span>{transferBanner}</span>
          </div>
          <button
            type="button"
            onClick={() => setTransferBanner(null)}
            className="text-xs text-amber-300 hover:text-white cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Mic Warning */}
      {micPermissionError && (
        <div className="flex items-center gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-200">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
          <span>{micPermissionError}</span>
        </div>
      )}

      {/* Main Split: Phone Handset + Live Transcript + Debug Drawer */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Column 1: Realistic Phone Dialer Chassis */}
        <div className="lg:col-span-4 rounded-3xl border border-slate-800 bg-gradient-to-b from-[#131B2C] to-[#0B101B] p-5 shadow-2xl space-y-5">
          {/* Speaker Earpiece & Status Row */}
          <div className="flex flex-col items-center gap-2 pt-1">
            <div className="w-16 h-1.5 rounded-full bg-slate-800" />
            <div className="w-full flex items-center justify-between text-xs pt-2">
              <span className="font-mono text-slate-400">
                {assistant.mode === 'pipeline' ? 'STT · LLM · TTS' : 'Fedora Pilot'}
              </span>
              <span
                className={`font-medium ${
                  callState === 'connected'
                    ? 'text-emerald-400'
                    : callState === 'dialing' || callState === 'ringing'
                      ? 'text-sky-400'
                      : callState === 'ended'
                        ? 'text-slate-400'
                        : 'text-slate-400'
                }`}
              >
                {callState === 'idle'
                  ? 'Ready to dial'
                  : callState === 'dialing'
                    ? 'Dialing...'
                    : callState === 'ringing'
                      ? 'Ringing...'
                      : callState === 'connected'
                        ? `Connected · ${formatTimer(elapsedSec)}`
                        : `Ended · ${formatTimer(elapsedSec)}`}
              </span>
            </div>
          </div>

          {/* Number Input & Assistant Routing */}
          <div className="rounded-2xl border border-slate-800/90 bg-[#070B13] p-4 space-y-3">
            <div className="flex items-center gap-2">
              <select
                aria-label="Country code"
                value={countryCode}
                disabled={isCallActive}
                onChange={(e) => setCountryCode(e.target.value)}
                className="rounded-lg bg-[#111827] border border-slate-800 px-2 py-2 text-xs font-mono text-slate-200 focus:outline-none focus:border-sky-500 disabled:opacity-60"
              >
                {COUNTRY_CODES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.label}
                  </option>
                ))}
              </select>
              <input
                type="tel"
                aria-label="Phone number"
                value={phoneNumber}
                disabled={isCallActive}
                onChange={(e) => setPhoneNumber(e.target.value)}
                className="flex-1 min-w-0 bg-transparent text-lg font-mono tabular-nums text-slate-100 focus:outline-none disabled:opacity-70"
              />
              {!isCallActive && phoneNumber.length > 0 && (
                <button
                  type="button"
                  aria-label="Backspace digit"
                  onClick={() => setPhoneNumber((p) => p.slice(0, -1))}
                  className="p-1.5 text-slate-400 hover:text-slate-100 cursor-pointer"
                >
                  <Delete className="w-4 h-4" />
                </button>
              )}
            </div>

            <div className="flex items-center justify-between text-xs pt-2 border-t border-slate-800/80">
              <span className="text-slate-400">Routed Agent</span>
              <span className="text-slate-200 font-medium">
                {assistant.name} — {assistant.companyName}
              </span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400">Post-Ring Greeting</span>
              <span
                className={
                  assistant.greetFirst !== false ? 'text-sky-300' : 'text-slate-400'
                }
              >
                {assistant.greetFirst !== false ? 'AI greets first' : 'Wait for caller'}
              </span>
            </div>
          </div>

          {/* Live Audio Waveform Visualizer & Mic Input Meter */}
          <div className="relative rounded-2xl border border-slate-800/80 bg-[#070B13] px-3 py-3 overflow-hidden space-y-2">
            {(callState === 'dialing' || callState === 'ringing') && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="w-24 h-24 rounded-full border border-sky-400/40 animate-ring-pulse" />
              </div>
            )}
            <canvas
              ref={canvasRef}
              width={320}
              height={56}
              className="w-full h-14 block"
            />
            {callState === 'connected' && (
              <div className="flex items-center justify-between gap-3 pt-1.5 border-t border-slate-800/70 text-[11px]">
                <span className="text-slate-400 truncate">
                  {isMuted ? 'Microphone muted' : voiceChannelStatus}
                </span>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="text-slate-500">Mic</span>
                  <div className="w-16 h-1.5 rounded-full bg-slate-800 overflow-hidden">
                    <div
                      className="h-full bg-sky-400 transition-all duration-75"
                      style={{ width: `${micLevel}%` }}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 12-key DTMF Keypad */}
          <div className="grid grid-cols-3 gap-2.5">
            {KEYPAD_KEYS.map((k) => (
              <button
                key={k.digit}
                type="button"
                onClick={() => handleKeypadPress(k.digit)}
                className="h-14 rounded-2xl border border-slate-800/90 bg-[#111827] hover:bg-slate-800 active:scale-[0.97] transition-all flex flex-col items-center justify-center cursor-pointer"
              >
                <span className="text-lg font-mono font-medium text-slate-100 leading-none">
                  {k.digit}
                </span>
                {k.sub && (
                  <span className="text-[9px] tracking-widest text-slate-500 mt-1">
                    {k.sub}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Primary Call Controls */}
          <div className="flex items-center justify-center gap-4 pt-1">
            {isCallActive ? (
              <>
                <button
                  type="button"
                  onClick={() => setIsMuted((m) => !m)}
                  aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
                  className={`w-13 h-13 rounded-full border flex items-center justify-center transition-colors cursor-pointer ${
                    isMuted
                      ? 'border-amber-500/50 bg-amber-500/15 text-amber-300'
                      : 'border-slate-700 bg-[#111827] text-slate-200 hover:bg-slate-800'
                  }`}
                >
                  {isMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
                </button>
                <button
                  type="button"
                  onClick={() => void handleEndCall()}
                  aria-label="End call"
                  className="w-16 h-16 rounded-full bg-rose-600 hover:bg-rose-500 text-white flex items-center justify-center shadow-lg shadow-rose-900/40 transition-colors cursor-pointer"
                >
                  <PhoneOff className="w-6 h-6" />
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => void handleDial()}
                className="w-full py-3.5 rounded-2xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-sm flex items-center justify-center gap-2.5 shadow-lg shadow-emerald-950/50 transition-colors cursor-pointer"
              >
                <Phone className="w-4 h-4" />
                <span>{callState === 'ended' ? 'Call Again' : 'Start Voice Call'}</span>
              </button>
            )}
          </div>

          {/* Fallback / Silent Text Turn Input while Connected */}
          {callState === 'connected' && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSubmitTextTurn();
              }}
              className="flex gap-2 pt-2 border-t border-slate-800/80"
            >
              <input
                type="text"
                value={textTurnInput}
                onChange={(e) => setTextTurnInput(e.target.value)}
                placeholder="Type caller turn (mic fallback)..."
                className="flex-1 min-w-0 rounded-lg bg-[#070B13] border border-slate-800 px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-sky-500"
              />
              <button
                type="submit"
                aria-label="Send simulated caller turn"
                className="px-3 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 cursor-pointer"
              >
                <Send className="w-3.5 h-3.5" />
              </button>
            </form>
          )}
        </div>

        {/* Column 2 & 3: Live Transcript + Demo Script + Debug Drawer */}
        <div
          className={`${
            debugOpen ? 'lg:col-span-8' : 'lg:col-span-8'
          } grid grid-cols-1 ${debugOpen ? 'xl:grid-cols-12' : ''} gap-6`}
        >
          {/* Live Transcript & Demo Script */}
          <div
            className={`${
              debugOpen ? 'xl:col-span-7' : ''
            } rounded-xl border border-slate-800/80 bg-[#111827] flex flex-col min-h-[540px] max-h-[680px] overflow-hidden`}
          >
            <div className="px-5 py-4 border-b border-slate-800/80 flex items-center justify-between">
              <div>
                <h2 className="text-base font-display font-semibold text-slate-100">
                  Live Transcript
                </h2>
                <p className="text-xs text-slate-400">
                  Interim speech appears muted; speaking over the agent triggers instant barge-in.
                </p>
              </div>
              <span className="text-xs font-mono tabular-nums text-slate-400">
                {transcript.filter((t) => !t.isInterim).length} entries
              </span>
            </div>

            {/* Transcript Stream */}
            <div className="flex-1 overflow-y-auto p-5 space-y-3.5">
              {transcript.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center py-12 px-4">
                  <Sparkles className="w-7 h-7 text-sky-400/70 mb-3" />
                  <p className="text-sm font-medium text-slate-200">
                    Press Start Voice Call to talk with {assistant.name}
                  </p>
                  <p className="mt-1 text-xs text-slate-400 max-w-sm leading-relaxed">
                    Answers are strictly grounded in {assistant.companyName}&apos;s loaded knowledge base with automatic echo cancellation and barge-in.
                  </p>
                </div>
              ) : (
                transcript.map((entry) => {
                  if (entry.role === 'system') {
                    return (
                      <div
                        key={entry.id}
                        className="flex items-center gap-2 text-xs text-amber-300 bg-amber-500/8 border border-amber-500/25 rounded-lg px-3 py-2"
                      >
                        <CalendarCheck2 className="w-3.5 h-3.5 shrink-0" />
                        <span>{entry.text}</span>
                      </div>
                    );
                  }

                  const isUser = entry.role === 'user';
                  return (
                    <div
                      key={entry.id}
                      className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
                    >
                      <span className="text-[11px] text-slate-400 mb-1">
                        {isUser ? 'Caller' : assistant.name}
                        {entry.interrupted && ' · interrupted'}
                      </span>
                      <div
                        className={`max-w-[85%] rounded-xl px-4 py-2.5 text-sm leading-relaxed ${
                          entry.isInterim
                            ? 'bg-slate-800/40 text-slate-400 italic border border-slate-800'
                            : isUser
                              ? 'bg-sky-500/15 border border-sky-500/30 text-slate-100'
                              : 'bg-[#090D16] border border-slate-800 text-slate-200'
                        }`}
                      >
                        {entry.text}
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={transcriptEndRef} />
            </div>

            {/* Collapsible 5-Question Demo Script */}
            <div className="border-t border-slate-800/80 bg-[#0B101B]">
              <button
                type="button"
                onClick={() => setDemoScriptOpen((o) => !o)}
                className="w-full px-5 py-2.5 flex items-center justify-between text-xs font-medium text-slate-300 hover:text-white cursor-pointer"
              >
                <span className="flex items-center gap-2">
                  <BookOpen className="w-3.5 h-3.5 text-sky-400" />
                  <span>
                    {isNepaliAssistant
                      ? `${assistant.companyName} Demo Script (5 Nepali Prompts)`
                      : `${assistant.companyName} Demo Script (5 Test Prompts)`}
                  </span>
                </span>
                {demoScriptOpen ? (
                  <ChevronDown className="w-3.5 h-3.5" />
                ) : (
                  <ChevronUp className="w-3.5 h-3.5" />
                )}
              </button>
              {demoScriptOpen && (
                <div className="px-5 pb-3.5 space-y-1.5 max-h-48 overflow-y-auto">
                  {(isNepaliAssistant
                    ? NEPALI_DEMO_SCRIPT_QUESTIONS
                    : DEMO_SCRIPT_QUESTIONS
                  ).map((q) => (
                    <div
                      key={q.label}
                      className="flex items-center justify-between gap-3 py-1.5 px-2.5 rounded-lg bg-[#111827] border border-slate-800/80 text-xs"
                    >
                      <div className="min-w-0">
                        <span className="font-medium text-sky-300 mr-2">{q.label}:</span>
                        <span className="text-slate-300">{q.text}</span>
                      </div>
                      {callState === 'connected' && (
                        <button
                          type="button"
                          onClick={() => handleSubmitTextTurn(q.text)}
                          className="shrink-0 px-2.5 py-1 rounded bg-slate-800 hover:bg-sky-500 hover:text-slate-950 text-[11px] font-medium text-slate-200 transition-colors cursor-pointer"
                        >
                          Send
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Debug Drawer: Latency Breakdown, Retrieved Chunks & Appointments */}
          {debugOpen && (
            <div className="xl:col-span-5 rounded-xl border border-slate-800/80 bg-[#111827] flex flex-col min-h-[540px] max-h-[680px] overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-800/80 flex items-center justify-between">
                <h2 className="text-base font-display font-semibold text-slate-100">
                  Debug &amp; Latency
                </h2>
                {turnMetrics.length > 0 && (
                  <select
                    aria-label="Select turn metrics"
                    value={activeMetric?.turnIndex ?? ''}
                    onChange={(e) => setSelectedMetricTurn(parseInt(e.target.value, 10))}
                    className="rounded-md bg-[#090D16] border border-slate-800 px-2 py-1 text-xs font-mono text-slate-200"
                  >
                    {turnMetrics.map((m) => (
                      <option key={m.turnIndex} value={m.turnIndex}>
                        Turn #{m.turnIndex}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div className="flex-1 overflow-y-auto p-5 space-y-5">
                {/* Per-Turn Latency Breakdown */}
                {activeMetric ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-slate-400">
                        Turn #{activeMetric.turnIndex} Latency ({activeMetric.mode})
                      </span>
                      <span
                        className={`text-xs font-mono tabular-nums font-semibold flex items-center gap-1 ${
                          activeMetric.totalLatencyMs > 1500
                            ? 'text-rose-400'
                            : 'text-emerald-400'
                        }`}
                      >
                        {activeMetric.totalLatencyMs > 1500 && (
                          <AlertTriangle className="w-3.5 h-3.5" />
                        )}
                        {activeMetric.totalLatencyMs} ms
                        {activeMetric.totalLatencyMs > 1500 ? ' (>1500ms)' : ''}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-2.5 text-xs">
                      <div className="rounded-lg border border-slate-800 bg-[#090D16] p-3">
                        <span className="text-slate-400 block">Endpointing</span>
                        <span className="mt-0.5 text-sm font-mono tabular-nums text-slate-100 block">
                          {activeMetric.endpointingDelayMs} ms
                        </span>
                      </div>
                      <div className="rounded-lg border border-slate-800 bg-[#090D16] p-3">
                        <span className="text-slate-400 block">Retrieval</span>
                        <span className="mt-0.5 text-sm font-mono tabular-nums text-slate-100 block">
                          {activeMetric.retrievalMs} ms
                        </span>
                      </div>
                      <div className="rounded-lg border border-slate-800 bg-[#090D16] p-3">
                        <span className="text-slate-400 block">LLM TTFT</span>
                        <span className="mt-0.5 text-sm font-mono tabular-nums text-slate-100 block">
                          {activeMetric.llmTtftMs} ms
                        </span>
                      </div>
                      <div className="rounded-lg border border-slate-800 bg-[#090D16] p-3">
                        <span className="text-slate-400 block">TTS TTFA</span>
                        <span className="mt-0.5 text-sm font-mono tabular-nums text-slate-100 block">
                          {activeMetric.ttsTtfaMs} ms
                        </span>
                      </div>
                    </div>

                    {/* Retrieved Chunks */}
                    <div className="pt-2 space-y-2">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium text-slate-300">
                          Knowledge Chunks Used
                        </span>
                        <span className="font-mono text-slate-400">
                          {activeMetric.contextStrategy === 'stuffed'
                            ? 'Full Context'
                            : `Top ${activeMetric.chunksUsed.length} RAG`}
                        </span>
                      </div>
                      {activeMetric.chunksUsed.length === 0 ? (
                        <p className="text-xs text-slate-500">
                          No chunk telemetry for this turn.
                        </p>
                      ) : (
                        <div className="space-y-2">
                          {activeMetric.chunksUsed.slice(0, 4).map((c) => (
                            <div
                              key={c.id}
                              className="rounded-lg border border-slate-800 bg-[#090D16] p-2.5 space-y-1"
                            >
                              <div className="flex items-center justify-between text-[11px]">
                                <span className="text-slate-300 font-medium truncate">
                                  {c.source}
                                </span>
                                <span className="font-mono tabular-nums text-sky-400 shrink-0 ml-2">
                                  {(c.similarity * 100).toFixed(1)}%
                                </span>
                              </div>
                              <p className="text-[11px] text-slate-400 line-clamp-3 leading-relaxed">
                                {c.text}
                              </p>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-slate-400 py-4">
                    Per-turn endpointing, retrieval, LLM TTFT, TTS TTFA, and matched chunks will appear here after the first caller turn.
                  </p>
                )}

                {/* Booked Appointments List (from book_appointment tool) */}
                <div className="pt-4 border-t border-slate-800/80 space-y-2.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-slate-300">
                      Booked Appointments (Tool Calls)
                    </span>
                    <span className="font-mono tabular-nums text-slate-400">
                      {appointments.length}
                    </span>
                  </div>
                  {appointments.length === 0 ? (
                    <p className="text-xs text-slate-500">
                      Ask the agent to book an appointment to trigger the tool call.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {appointments.slice(0, 6).map((appt) => (
                        <div
                          key={appt.id}
                          className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-2.5 text-xs space-y-0.5"
                        >
                          <div className="flex items-center justify-between font-medium text-emerald-300">
                            <span>{appt.name}</span>
                            <span className="font-mono tabular-nums text-[11px]">
                              {appt.phone}
                            </span>
                          </div>
                          <p className="text-slate-300">{appt.datetime}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
