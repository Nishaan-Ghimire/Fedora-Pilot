/**
 * WebAudio utilities for Fedora-Pilot:
 * - 24kHz 16-bit mono RAW PCM streaming player with gapless scheduling & instant barge-in flush
 * - Realistic North American ringback tone generator (440Hz + 480Hz)
 * - 16kHz AudioWorklet microphone PCM capture (with ScriptProcessor + resampler fallback)
 * - Smart streaming sentence chunker
 */

export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function createCompatibleAudioContext(preferredSampleRate?: number): AudioContext {
  if (preferredSampleRate) {
    try {
      return new AudioContext({ sampleRate: preferredSampleRate });
    } catch {
      return new AudioContext();
    }
  }
  return new AudioContext();
}

/**
 * Decodes raw 16-bit signed little-endian mono PCM (24kHz) into an AudioBuffer.
 * WebAudio automatically resamples the 24kHz AudioBuffer to the device output rate.
 */
export function decodeRawPcm24k(
  audioCtx: AudioContext,
  base64Pcm: string,
  sampleRate = 24000
): AudioBuffer {
  const bytes = base64ToUint8Array(base64Pcm);
  const evenByteLength = bytes.byteLength - (bytes.byteLength % 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, evenByteLength);
  const sampleCount = evenByteLength / 2;

  const buffer = audioCtx.createBuffer(1, Math.max(1, sampleCount), sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < sampleCount; i++) {
    channel[i] = view.getInt16(i * 2, true) / 32768;
  }
  return buffer;
}

export interface ScheduledSegmentCallbacks {
  onStart?: () => void;
  onEnded?: () => void;
}

export class PcmStreamPlayer {
  private ctx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  public analyser: AnalyserNode | null = null;
  private nextStartTime = 0;
  private activeSources = new Set<AudioBufferSourceNode>();
  private generation = 0;

  ensureContext(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = createCompatibleAudioContext(24000);
      this.gainNode = this.ctx.createGain();
      this.gainNode.gain.value = 1.0;
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.78;
      this.gainNode.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  get isPlaying(): boolean {
    return this.activeSources.size > 0;
  }

  enqueuePcmBase64(
    base64Pcm: string,
    callbacks: ScheduledSegmentCallbacks = {},
    sampleRate = 24000
  ): { durationSec: number; generation: number } {
    const ctx = this.ensureContext();
    const audioBuffer = decodeRawPcm24k(ctx, base64Pcm, sampleRate);
    return this.enqueueAudioBuffer(audioBuffer, callbacks);
  }

  enqueueAudioBuffer(
    audioBuffer: AudioBuffer,
    callbacks: ScheduledSegmentCallbacks = {}
  ): { durationSec: number; generation: number } {
    const ctx = this.ensureContext();
    if (!this.gainNode) {
      this.gainNode = ctx.createGain();
      this.gainNode.connect(ctx.destination);
    }

    const gen = this.generation;
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.gainNode);

    const scheduleStart = () => {
      if (this.generation !== gen) return;
      const now = ctx.currentTime;
      const startAt = Math.max(now + 0.015, this.nextStartTime);
      this.nextStartTime = startAt + audioBuffer.duration;
      this.activeSources.add(source);

      const delayMs = Math.max(0, (startAt - now) * 1000);
      const startTimer = window.setTimeout(() => {
        if (this.generation === gen) {
          callbacks.onStart?.();
        }
      }, delayMs);

      source.onended = () => {
        window.clearTimeout(startTimer);
        this.activeSources.delete(source);
        if (this.generation === gen) {
          callbacks.onEnded?.();
        }
      };

      source.start(startAt);
    };

    if (ctx.state === 'suspended') {
      void ctx.resume().then(scheduleStart).catch(scheduleStart);
    } else {
      scheduleStart();
    }

    return { durationSec: audioBuffer.duration, generation: gen };
  }

  /**
   * Immediately halts all queued & currently playing audio (used for Barge-In & Hangup).
   */
  flush(): void {
    this.generation += 1;
    this.nextStartTime = 0;
    for (const source of this.activeSources) {
      try {
        source.onended = null;
        source.stop(0);
        source.disconnect();
      } catch {
        // already stopped
      }
    }
    this.activeSources.clear();
  }

  close(): void {
    this.flush();
    if (this.ctx && this.ctx.state !== 'closed') {
      void this.ctx.close().catch(() => {});
    }
    this.ctx = null;
    this.gainNode = null;
    this.analyser = null;
  }
}

/**
 * Generates North American ringback tone (440Hz + 480Hz) while Dialing/Ringing.
 */
export class RingbackTone {
  private ctx: AudioContext | null = null;
  private intervalId: number | null = null;
  private osc1: OscillatorNode | null = null;
  private osc2: OscillatorNode | null = null;
  private gain: GainNode | null = null;

  start(): void {
    this.stop();
    try {
      this.ctx = new AudioContext();
      if (this.ctx.state === 'suspended') {
        void this.ctx.resume().catch(() => {});
      }
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 0;
      this.gain.connect(this.ctx.destination);

      this.osc1 = this.ctx.createOscillator();
      this.osc2 = this.ctx.createOscillator();
      this.osc1.type = 'sine';
      this.osc2.type = 'sine';
      this.osc1.frequency.value = 440;
      this.osc2.frequency.value = 480;
      this.osc1.connect(this.gain);
      this.osc2.connect(this.gain);
      this.osc1.start();
      this.osc2.start();

      const triggerRing = () => {
        if (!this.ctx || !this.gain) return;
        const now = this.ctx.currentTime;
        this.gain.gain.cancelScheduledValues(now);
        this.gain.gain.setValueAtTime(0.0001, now);
        this.gain.gain.linearRampToValueAtTime(0.055, now + 0.04);
        this.gain.gain.setValueAtTime(0.055, now + 1.45);
        this.gain.gain.linearRampToValueAtTime(0.0001, now + 1.5);
      };

      triggerRing();
      this.intervalId = window.setInterval(triggerRing, 3200);
    } catch {
      // Ignore WebAudio autoplay restrictions
    }
  }

  stop(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    try {
      this.osc1?.stop();
      this.osc2?.stop();
    } catch {
      // ignore
    }
    this.osc1 = null;
    this.osc2 = null;
    this.gain = null;
    if (this.ctx && this.ctx.state !== 'closed') {
      void this.ctx.close().catch(() => {});
    }
    this.ctx = null;
  }
}

/**
 * Plays a short dual-tone multi-frequency (DTMF) keypad beep.
 */
const DTMF_FREQS: Record<string, [number, number]> = {
  '1': [697, 1209],
  '2': [697, 1336],
  '3': [697, 1477],
  '4': [770, 1209],
  '5': [770, 1336],
  '6': [770, 1477],
  '7': [852, 1209],
  '8': [852, 1336],
  '9': [852, 1477],
  '*': [941, 1209],
  '0': [941, 1336],
  '#': [941, 1477],
};

export function playDtmfDigit(digit: string): void {
  const pair = DTMF_FREQS[digit];
  if (!pair) return;
  try {
    const ctx = new AudioContext();
    const gain = ctx.createGain();
    gain.gain.value = 0.04;
    gain.connect(ctx.destination);
    const o1 = ctx.createOscillator();
    const o2 = ctx.createOscillator();
    o1.frequency.value = pair[0];
    o2.frequency.value = pair[1];
    o1.connect(gain);
    o2.connect(gain);
    o1.start();
    o2.start();
    window.setTimeout(() => {
      try {
        o1.stop();
        o2.stop();
        void ctx.close();
      } catch {
        // ignore
      }
    }, 95);
  } catch {
    // ignore
  }
}

function downsampleTo16kPcm16(input: Float32Array, inputSampleRate: number): ArrayBuffer {
  if (inputSampleRate === 16000) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const clamped = Math.max(-1, Math.min(1, input[i]));
      out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    }
    return out.buffer;
  }

  const ratio = inputSampleRate / 16000;
  const newLength = Math.max(1, Math.floor(input.length / ratio));
  const out = new Int16Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = input[idx] ?? 0;
    const s1 = input[Math.min(idx + 1, input.length - 1)] ?? s0;
    const sample = s0 + (s1 - s0) * frac;
    const clamped = Math.max(-1, Math.min(1, sample));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out.buffer;
}

const WORKLET_PROCESSOR_CODE = `
class Pcm16CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(1024);
    this._offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const channel = input[0];
    for (let i = 0; i < channel.length; i++) {
      this._buffer[this._offset++] = channel[i];
      if (this._offset >= this._buffer.length) {
        const out = this._buffer.slice(0);
        this.port.postMessage(out.buffer, [out.buffer]);
        this._offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm16-capture-processor', Pcm16CaptureProcessor);
`;

export interface RealtimeMicHandle {
  analyser: AnalyserNode;
  stop: () => void;
}

/**
 * Starts 16kHz AudioWorklet PCM capture from an existing MediaStream, with automatic
 * resampling and ScriptProcessorNode fallback if AudioWorklet is blocked by browser/CSP.
 */
export async function startRealtimeMicWorklet(
  stream: MediaStream,
  onPcmChunkBase64: (base64: string) => void
): Promise<RealtimeMicHandle> {
  const ctx = createCompatibleAudioContext(16000);
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }

  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.78;
  const silentGain = ctx.createGain();
  silentGain.gain.value = 0;

  let cleanupNode: () => void = () => {};

  try {
    const blob = new Blob([WORKLET_PROCESSOR_CODE], { type: 'application/javascript' });
    const moduleUrl = URL.createObjectURL(blob);
    try {
      await ctx.audioWorklet.addModule(moduleUrl);
    } finally {
      URL.revokeObjectURL(moduleUrl);
    }

    const workletNode = new AudioWorkletNode(ctx, 'pcm16-capture-processor');
    workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      const floats = new Float32Array(event.data);
      const pcmBuf = downsampleTo16kPcm16(floats, ctx.sampleRate);
      onPcmChunkBase64(arrayBufferToBase64(pcmBuf));
    };

    source.connect(analyser);
    analyser.connect(workletNode);
    workletNode.connect(silentGain);
    silentGain.connect(ctx.destination);

    cleanupNode = () => {
      workletNode.port.onmessage = null;
      workletNode.disconnect();
    };
  } catch {
    // Fallback to ScriptProcessorNode if AudioWorklet is unavailable
    const processor = ctx.createScriptProcessor(2048, 1, 1);
    processor.onaudioprocess = (ev) => {
      const floats = ev.inputBuffer.getChannelData(0);
      const pcmBuf = downsampleTo16kPcm16(floats, ctx.sampleRate);
      onPcmChunkBase64(arrayBufferToBase64(pcmBuf));
    };
    source.connect(analyser);
    analyser.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(ctx.destination);

    cleanupNode = () => {
      processor.onaudioprocess = null;
      processor.disconnect();
    };
  }

  return {
    analyser,
    stop: () => {
      try {
        cleanupNode();
        analyser.disconnect();
        source.disconnect();
        silentGain.disconnect();
      } catch {
        // ignore
      }
      if (ctx.state !== 'closed') {
        void ctx.close().catch(() => {});
      }
    },
  };
}

/**
 * Extracts complete sentences from a streaming buffer without splitting common abbreviations.
 */
const ABBREVIATIONS = /(?:Dr|Mr|Mrs|Ms|St|Ave|No|Inc|Ltd|vs|a\.m|p\.m|e\.g|i\.e)$/i;

export function extractCompleteSentences(buffer: string): {
  sentences: string[];
  remainder: string;
} {
  const sentences: string[] = [];
  let start = 0;

  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i];
    if (ch === '.' || ch === '!' || ch === '?' || ch === '।' || ch === '॥') {
      const next = buffer[i + 1];
      const prev = buffer[i - 1];
      // Skip decimal numbers like 145.50
      if (ch === '.' && prev && /\d/.test(prev) && next && /\d/.test(next)) {
        continue;
      }
      const isDevanagariDanda = ch === '।' || ch === '॥';
      const isBoundary =
        next === ' ' ||
        next === '\n' ||
        next === '\t' ||
        next === '"' ||
        next === "'" ||
        (isDevanagariDanda && next !== undefined && next !== '।' && next !== '॥');

      if (isBoundary) {
        const candidate = buffer.slice(start, i + 1).trim();
        const wordBefore = candidate.slice(0, -1).split(/\s+/).pop() ?? '';
        if (ch === '.' && ABBREVIATIONS.test(wordBefore)) {
          continue;
        }
        if (candidate.length >= 2) {
          sentences.push(candidate);
          start = i + 1;
        }
      }
    }
  }

  return {
    sentences,
    remainder: buffer.slice(start),
  };
}
