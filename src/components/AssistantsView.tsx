import { useEffect, useRef, useState } from 'react';
import { PhoneCall, Plus, Save, Trash2, Volume2 } from 'lucide-react';
import {
  VOICE_OPTIONS,
  type AgentMode,
  type Assistant,
  type VoiceName,
} from '../types';
import { PcmStreamPlayer } from '../utils/audio';

interface AssistantsViewProps {
  assistants: Assistant[];
  selectedAssistantId: string;
  onSelectAssistant: (id: string) => void;
  onSaveAssistant: (draft: Partial<Assistant>) => Promise<Assistant | null>;
  onDeleteAssistant: (id: string) => Promise<void>;
  onGoToDialer: () => void;
  onNotify: (type: 'error' | 'success' | 'info', title: string, detail?: string) => void;
}

const LANGUAGES = [
  { code: 'ne-NP', label: 'Nepali — नेपाली (Nepal)' },
  { code: 'en-US', label: 'English (US)' },
  { code: 'en-GB', label: 'English (UK)' },
  { code: 'hi-IN', label: 'Hindi (IN)' },
  { code: 'es-ES', label: 'Spanish (ES)' },
  { code: 'fr-FR', label: 'French (FR)' },
  { code: 'de-DE', label: 'German (DE)' },
  { code: 'ja-JP', label: 'Japanese (JP)' },
];

export function AssistantsView({
  assistants,
  selectedAssistantId,
  onSelectAssistant,
  onSaveAssistant,
  onDeleteAssistant,
  onGoToDialer,
  onNotify,
}: AssistantsViewProps) {
  const active =
    assistants.find((a) => a.id === selectedAssistantId) ?? assistants[0];

  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [name, setName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [greetFirst, setGreetFirst] = useState(true);
  const [firstMessage, setFirstMessage] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [language, setLanguage] = useState('en-US');
  const [voice, setVoice] = useState<VoiceName>('Kore');
  const [styleInstruction, setStyleInstruction] = useState('');
  const [temperature, setTemperature] = useState(0.3);
  const [maxSentences, setMaxSentences] = useState(2);
  const [mode, setMode] = useState<AgentMode>('pipeline');
  const [stuffAllContext, setStuffAllContext] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);

  const playerRef = useRef<PcmStreamPlayer | null>(null);

  useEffect(() => {
    if (!active || isCreatingNew) return;
    setName(active.name);
    setCompanyName(active.companyName);
    setPhoneNumber(active.phoneNumber);
    setGreetFirst(active.greetFirst ?? true);
    setFirstMessage(active.firstMessage);
    setSystemPrompt(active.systemPrompt);
    setLanguage(active.language);
    setVoice(active.voice);
    setStyleInstruction(active.styleInstruction);
    setTemperature(active.temperature);
    setMaxSentences(active.maxSentences);
    setMode(active.mode);
    setStuffAllContext(active.stuffAllContext);
  }, [active, isCreatingNew]);

  useEffect(() => {
    return () => {
      playerRef.current?.close();
    };
  }, []);

  const handleStartNew = () => {
    setIsCreatingNew(true);
    setName('');
    setCompanyName('');
    setPhoneNumber('+977 1-555-0188');
    setGreetFirst(true);
    setFirstMessage('नमस्ते, फोन गर्नुभएकोमा धन्यवाद। म हजुरलाई कसरी सहयोग गर्न सक्छु?');
    setSystemPrompt(
      'तपाईं कम्पनीको विनम्र र सहयोगी नेपाली भ्वाइस सहायक हुनुहुन्छ। कल गर्ने व्यक्तिलाई समय, सेवा, शुल्क र अपोइन्टमेन्ट बुक गर्न मद्दत गर्नुहोस्।'
    );
    setLanguage('ne-NP');
    setVoice('Kore');
    setStyleInstruction('Speak warmly, politely, and naturally in Nepali at a calm front-desk pace');
    setTemperature(0.3);
    setMaxSentences(2);
    setMode('pipeline');
    setStuffAllContext(false);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !companyName.trim()) {
      onNotify('error', 'Missing required fields', 'Name and Company Name are required.');
      return;
    }
    setIsSaving(true);
    try {
      const saved = await onSaveAssistant({
        id: isCreatingNew ? undefined : active?.id,
        name: name.trim(),
        companyName: companyName.trim(),
        phoneNumber: phoneNumber.trim(),
        greetFirst,
        firstMessage: firstMessage.trim(),
        systemPrompt: systemPrompt.trim(),
        language,
        voice,
        styleInstruction: styleInstruction.trim(),
        temperature,
        maxSentences,
        mode,
        stuffAllContext,
      });
      if (saved) {
        setIsCreatingNew(false);
        onSelectAssistant(saved.id);
        onNotify('success', `${saved.name} saved`, `${saved.companyName} configuration updated.`);
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handlePreviewVoice = async () => {
    setIsPreviewing(true);
    try {
      if (!playerRef.current) {
        playerRef.current = new PcmStreamPlayer();
      }
      playerRef.current.flush();

      const sampleText =
        firstMessage.trim() ||
        `Hi there, this is ${name || 'your voice assistant'} from ${companyName || 'the team'}. How can I help you today?`;

      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: sampleText,
          voiceName: voice,
          styleInstruction,
        }),
      });
      const data = (await res.json()) as {
        audio?: string;
        sampleRate?: number;
        error?: string;
      };
      if (!res.ok || !data.audio) {
        throw new Error(data.error || 'Voice preview failed.');
      }
      playerRef.current.enqueuePcmBase64(data.audio, {}, data.sampleRate ?? 24000);
    } catch (err) {
      onNotify(
        'error',
        'Voice preview failed',
        err instanceof Error ? err.message : 'Could not synthesize preview audio.'
      );
    } finally {
      setIsPreviewing(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto p-6 lg:p-8 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-5 border-b border-slate-800/80">
        <div>
          <h1 className="text-2xl font-display font-semibold text-slate-100">
            Assistants
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Configure voice persona, conversation cadence, and Pipeline or Realtime execution.
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={handleStartNew}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-700 bg-[#111827] hover:bg-slate-800 text-sm font-medium text-slate-100 transition-colors cursor-pointer whitespace-nowrap"
          >
            <Plus className="w-4 h-4 text-sky-400" />
            <span>New Assistant</span>
          </button>
          <button
            type="button"
            onClick={onGoToDialer}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 text-sm font-semibold transition-colors cursor-pointer whitespace-nowrap"
          >
            <PhoneCall className="w-4 h-4" />
            <span>Test in Dialer</span>
          </button>
        </div>
      </div>

      {/* Assistant Selector Strip */}
      <div className="flex flex-wrap items-center gap-2">
        {assistants.map((item) => {
          const selected = !isCreatingNew && item.id === active?.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                setIsCreatingNew(false);
                onSelectAssistant(item.id);
              }}
              className={`px-3.5 py-2 rounded-lg border text-sm font-medium transition-colors cursor-pointer whitespace-nowrap ${
                selected
                  ? 'border-sky-500/60 bg-sky-500/15 text-sky-200'
                  : 'border-slate-800 bg-[#111827] text-slate-300 hover:border-slate-700 hover:text-white'
              }`}
            >
              <span>{item.name}</span>
              <span className="text-slate-500 mx-1.5">·</span>
              <span className="text-xs text-slate-400">{item.companyName}</span>
            </button>
          );
        })}
        {isCreatingNew && (
          <span className="px-3.5 py-2 rounded-lg border border-sky-500/60 bg-sky-500/15 text-sm font-medium text-sky-200">
            New Assistant Draft
          </span>
        )}
      </div>

      {/* Editor Form */}
      <form
        onSubmit={handleSave}
        className="rounded-xl border border-slate-800/80 bg-[#111827]/90 p-6 space-y-6"
      >
        {/* Architecture Mode Segmented Toggle */}
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 pb-5 border-b border-slate-800/80">
          <div>
            <h2 className="text-base font-display font-semibold text-slate-100">
              Voice Pipeline Mode
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Choose sentence-chunked RAG Pipeline or Fedora Pilot realtime audio.
            </p>
          </div>
          <div className="inline-flex p-1 rounded-lg bg-[#090D16] border border-slate-800 shrink-0">
            <button
              type="button"
              onClick={() => setMode('pipeline')}
              className={`px-3.5 py-2 rounded-md text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                mode === 'pipeline'
                  ? 'bg-sky-500 text-slate-950 font-semibold'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              Pipeline (STT → LLM → TTS)
            </button>
            <button
              type="button"
              onClick={() => setMode('realtime')}
              className={`px-3.5 py-2 rounded-md text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                mode === 'realtime'
                  ? 'bg-sky-500 text-slate-950 font-semibold'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              Realtime (Fedora Pilot)
            </button>
          </div>
        </div>

        {/* Identity Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          <div>
            <label
              htmlFor="ast-name"
              className="block text-xs font-medium text-slate-300 mb-1.5"
            >
              Agent Name
            </label>
            <input
              id="ast-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Aria"
              className="w-full rounded-lg bg-[#090D16] border border-slate-800 px-3.5 py-2.5 text-sm text-slate-100 focus:outline-none focus:border-sky-500"
              required
            />
          </div>

          <div>
            <label
              htmlFor="ast-company"
              className="block text-xs font-medium text-slate-300 mb-1.5"
            >
              Company Name
            </label>
            <input
              id="ast-company"
              type="text"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder="e.g. Acme Dental"
              className="w-full rounded-lg bg-[#090D16] border border-slate-800 px-3.5 py-2.5 text-sm text-slate-100 focus:outline-none focus:border-sky-500"
              required
            />
          </div>

          <div>
            <label
              htmlFor="ast-phone"
              className="block text-xs font-medium text-slate-300 mb-1.5"
            >
              Mapped Phone Number
            </label>
            <input
              id="ast-phone"
              type="text"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              placeholder="+1 (555) 010-0199"
              className="w-full rounded-lg bg-[#090D16] border border-slate-800 px-3.5 py-2.5 text-sm font-mono tabular-nums text-slate-100 focus:outline-none focus:border-sky-500"
            />
          </div>
        </div>

        {/* Post-Ring Greeting Toggle & First Message */}
        <div className="rounded-xl border border-slate-800 bg-[#090D16] p-4 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <span className="block text-sm font-medium text-slate-100">
                AI Greets First (After Ringing)
              </span>
              <p className="text-xs text-slate-400 mt-0.5">
                {greetFirst
                  ? 'Enabled: Plays the greeting message immediately once ringing ends and the call connects.'
                  : 'Disabled: Call connects silently after ringing and waits for the caller to speak first.'}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={greetFirst}
              aria-label="Enable AI greet first after ringing"
              onClick={() => setGreetFirst((v) => !v)}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors cursor-pointer ${
                greetFirst
                  ? 'bg-sky-500 border-sky-400'
                  : 'bg-slate-800 border-slate-700'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  greetFirst ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          <div className={greetFirst ? '' : 'opacity-50'}>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
              <label
                htmlFor="ast-first-msg"
                className="block text-xs font-medium text-slate-300"
              >
                First Message (Pre-cached while ringing for instant post-ring playback)
              </label>
              {greetFirst && (
                <button
                  type="button"
                  onClick={() =>
                    setFirstMessage(
                      'नमस्ते! म सुन्दरहरैँचा नगरपालिकाको एआई सहयोगी बोल्दै छु। हजुरलाई कसरी मद्दत गर्न सक्छु?'
                    )
                  }
                  className="text-[11px] font-medium text-sky-400 hover:text-sky-300 transition-colors cursor-pointer"
                >
                  Use Sundarharaicha Greeting
                </button>
              )}
            </div>
            <input
              id="ast-first-msg"
              type="text"
              disabled={!greetFirst}
              value={firstMessage}
              onChange={(e) => setFirstMessage(e.target.value)}
              placeholder="नमस्ते! म सुन्दरहरैँचा नगरपालिकाको एआई सहयोगी बोल्दै छु। हजुरलाई कसरी मद्दत गर्न सक्छु?"
              className="w-full rounded-lg bg-[#111827] border border-slate-800 px-3.5 py-2.5 text-sm text-slate-100 focus:outline-none focus:border-sky-500 disabled:cursor-not-allowed"
            />
          </div>
        </div>

        {/* System Prompt */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label
              htmlFor="ast-system-prompt"
              className="block text-xs font-medium text-slate-300"
            >
              System Prompt (Company grounding & phone rules are injected automatically)
            </label>
            <span className="text-xs text-slate-500">
              Answers strictly from &lt;knowledge&gt;
            </span>
          </div>
          <textarea
            id="ast-system-prompt"
            rows={4}
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            className="w-full rounded-lg bg-[#090D16] border border-slate-800 px-3.5 py-2.5 text-sm text-slate-100 leading-relaxed focus:outline-none focus:border-sky-500"
          />
        </div>

        {/* Voice Picker + Style Instruction */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 pt-2 border-t border-slate-800/80">
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-slate-300">
                Voice Selection
              </span>
              <button
                type="button"
                onClick={handlePreviewVoice}
                disabled={isPreviewing}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-700 bg-[#090D16] hover:bg-slate-800 text-xs font-medium text-sky-300 transition-colors cursor-pointer disabled:opacity-50"
              >
                <Volume2 className="w-3.5 h-3.5" />
                <span>{isPreviewing ? 'Synthesizing...' : `Preview ${voice}`}</span>
              </button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
              {VOICE_OPTIONS.map((v) => {
                const isSelected = voice === v.name;
                return (
                  <button
                    key={v.name}
                    type="button"
                    onClick={() => setVoice(v.name)}
                    className={`text-left p-3 rounded-lg border transition-colors cursor-pointer ${
                      isSelected
                        ? 'border-sky-500 bg-sky-500/12 text-white'
                        : 'border-slate-800 bg-[#090D16] text-slate-300 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center justify-between text-xs font-semibold">
                      <span>{v.name}</span>
                      <span className="text-[11px] font-normal text-slate-400">
                        {v.genderLabel}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] text-slate-400 line-clamp-2 leading-snug">
                      {v.tone}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <label
                htmlFor="ast-style"
                className="block text-xs font-medium text-slate-300 mb-1.5"
              >
                TTS Style Instruction
              </label>
              <input
                id="ast-style"
                type="text"
                value={styleInstruction}
                onChange={(e) => setStyleInstruction(e.target.value)}
                placeholder="Speak warmly, at a calm, natural pace"
                className="w-full rounded-lg bg-[#090D16] border border-slate-800 px-3.5 py-2.5 text-sm text-slate-100 focus:outline-none focus:border-sky-500"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label
                  htmlFor="ast-lang"
                  className="block text-xs font-medium text-slate-300 mb-1.5"
                >
                  Language
                </label>
                <select
                  id="ast-lang"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  className="w-full rounded-lg bg-[#090D16] border border-slate-800 px-3 py-2.5 text-sm text-slate-100 focus:outline-none focus:border-sky-500"
                >
                  {LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label
                    htmlFor="ast-temp"
                    className="text-xs font-medium text-slate-300"
                  >
                    Temperature
                  </label>
                  <span className="text-xs font-mono tabular-nums text-sky-400">
                    {temperature.toFixed(1)}
                  </span>
                </div>
                <input
                  id="ast-temp"
                  type="range"
                  min={0}
                  max={1}
                  step={0.1}
                  value={temperature}
                  onChange={(e) => setTemperature(parseFloat(e.target.value))}
                  className="w-full accent-sky-500 mt-2 cursor-pointer"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label
                    htmlFor="ast-sentences"
                    className="text-xs font-medium text-slate-300"
                  >
                    Max Sentences
                  </label>
                  <span className="text-xs font-mono tabular-nums text-sky-400">
                    {maxSentences}
                  </span>
                </div>
                <input
                  id="ast-sentences"
                  type="range"
                  min={1}
                  max={5}
                  step={1}
                  value={maxSentences}
                  onChange={(e) => setMaxSentences(parseInt(e.target.value, 10))}
                  className="w-full accent-sky-500 mt-2 cursor-pointer"
                />
              </div>
            </div>

            <label className="flex items-start gap-3 p-3 rounded-lg border border-slate-800 bg-[#090D16] cursor-pointer">
              <input
                type="checkbox"
                checked={stuffAllContext}
                onChange={(e) => setStuffAllContext(e.target.checked)}
                className="mt-0.5 accent-sky-500"
              />
              <div>
                <span className="text-xs font-medium text-slate-200 block">
                  Stuff entire knowledge base into prompt (&lt; 30k tokens)
                </span>
                <span className="text-[11px] text-slate-400">
                  Skips vector retrieval and injects all company documents directly when total KB stays under 30,000 tokens.
                </span>
              </div>
            </label>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between pt-4 border-t border-slate-800/80">
          <div>
            {!isCreatingNew && assistants.length > 1 && active && (
              <button
                type="button"
                onClick={() => onDeleteAssistant(active.id)}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-rose-500/30 text-rose-300 hover:bg-rose-500/10 text-xs font-medium transition-colors cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Delete Assistant</span>
              </button>
            )}
          </div>
          <div className="flex items-center gap-3">
            {isCreatingNew && (
              <button
                type="button"
                onClick={() => setIsCreatingNew(false)}
                className="px-4 py-2 rounded-lg border border-slate-700 text-xs font-medium text-slate-300 hover:text-white cursor-pointer"
              >
                Cancel
              </button>
            )}
            <button
              type="submit"
              disabled={isSaving}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 text-sm font-semibold transition-colors cursor-pointer disabled:opacity-50"
            >
              <Save className="w-4 h-4" />
              <span>{isSaving ? 'Saving...' : 'Save Assistant'}</span>
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
