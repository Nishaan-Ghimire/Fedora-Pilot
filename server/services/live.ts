import type { IncomingMessage } from 'node:http';
import { Modality, type LiveServerMessage, type Session } from '@google/genai';
import { WebSocket, WebSocketServer } from 'ws';
import { MODEL_CONFIG } from '../config/models.ts';
import { MUNICIPALITY_ASSISTANT_ID } from '../../src/municipality.ts';
import type { Appointment } from '../../src/types.ts';
import { markGeminiClientUnavailable, recordGeminiUsage, withModelFallback } from './gemini.ts';
import { getAllKnowledgeText } from './kb.ts';
import { buildAgentSystemInstruction, getVoiceToolDeclarations } from './prompts.ts';
import { getStore, saveStore } from './store.ts';

interface LiveStartMessage {
  type: 'start';
  assistantId: string;
}

interface LiveAudioMessage {
  type: 'audio';
  data: string;
}

interface LiveTextMessage {
  type: 'text';
  text: string;
}

type ClientLiveMessage = LiveStartMessage | LiveAudioMessage | LiveTextMessage;

function sendJson(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function waitForLiveSession(connection: Promise<Session>, signal: AbortSignal): Promise<Session> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();

    void connection.then((session) => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) session.close();
      else resolve(session);
    }, (error) => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    }).catch(reject);
  });
}

export function attachLiveWebSocketServer(wss: WebSocketServer): void {
  wss.on('connection', (clientWs: WebSocket, _req: IncomingMessage) => {
    let liveSession: Session | null = null;
    let isConnecting = false;
    const connectionLifetime = new AbortController();
    let isClosing = false;

    const cleanup = () => {
      if (isClosing) return;
      isClosing = true;
      connectionLifetime.abort();
      if (liveSession) {
        try {
          liveSession.close();
        } catch {
          // ignore close errors
        }
        liveSession = null;
      }
    };

    clientWs.on('close', cleanup);
    clientWs.on('error', cleanup);

    clientWs.on('message', async (rawData) => {
      let msg: ClientLiveMessage;
      try {
        msg = JSON.parse(rawData.toString()) as ClientLiveMessage;
      } catch {
        sendJson(clientWs, { type: 'error', message: 'Invalid WebSocket JSON payload.' });
        return;
      }

      if (msg.type === 'start') {
        if (liveSession || isConnecting || isClosing) return;
        const assistantId = msg.assistantId || MUNICIPALITY_ASSISTANT_ID;
        const store = getStore();
        const assistant =
          store.assistants.find((a) => a.id === assistantId) ?? store.assistants[0];

        if (!assistant) {
          sendJson(clientWs, { type: 'error', message: 'Assistant not found.' });
          return;
        }

        const kb = getAllKnowledgeText(assistant.id);
        const baseInstruction = buildAgentSystemInstruction(assistant, kb.text);
        const shouldGreetFirst = assistant.greetFirst !== false && Boolean(assistant.firstMessage.trim());
        const liveInstruction = shouldGreetFirst
          ? `${baseInstruction}\n\nNote: When the call connects after ringing, you have already greeted the caller with: "${assistant.firstMessage}". Wait for the caller to speak and assist them directly.`
          : `${baseInstruction}\n\nNote: Greeting first is DISABLED for this call. Do NOT speak first when the call connects; wait silently until the caller speaks, then respond naturally.`;

        isConnecting = true;
        try {
          const { modelUsed } = await withModelFallback(
            MODEL_CONFIG.LIVE_MODEL,
            MODEL_CONFIG.LIVE_FALLBACK_MODELS,
            async (model, ai) => {
              let accepted = false;
              const signal = AbortSignal.any([
                connectionLifetime.signal,
                AbortSignal.timeout(8_000),
              ]);
              const connection = ai.live.connect({
                model,
                config: {
                  responseModalities: [Modality.AUDIO],
                  speechConfig: {
                    voiceConfig: {
                      prebuiltVoiceConfig: { voiceName: assistant.voice || 'Kore' },
                    },
                  },
                  inputAudioTranscription: {},
                  outputAudioTranscription: {},
                  systemInstruction: liveInstruction,
                  tools: [{ functionDeclarations: getVoiceToolDeclarations(assistant.id) }],
                },
                callbacks: {
                  onmessage: (message: LiveServerMessage) => {
                    if (!accepted || isClosing) return;
                    recordGeminiUsage(ai, message.usageMetadata?.totalTokenCount);
                    const content = message.serverContent;

                    if (content?.interrupted) {
                      sendJson(clientWs, { type: 'interrupted' });
                    }

                    if (content?.inputTranscription?.text) {
                      sendJson(clientWs, {
                        type: 'inputTranscript',
                        text: content.inputTranscription.text,
                      });
                    }

                    if (content?.outputTranscription?.text) {
                      sendJson(clientWs, {
                        type: 'outputTranscript',
                        text: content.outputTranscription.text,
                      });
                    }

                    for (const part of content?.modelTurn?.parts ?? []) {
                      if (part.inlineData?.data) {
                        sendJson(clientWs, {
                          type: 'audio',
                          data: part.inlineData.data,
                        });
                      }
                    }

                    if (content?.turnComplete) {
                      sendJson(clientWs, { type: 'turnComplete' });
                    }

                    const calls = message.toolCall?.functionCalls;
                    if (calls && calls.length > 0 && liveSession) {
                      const functionResponses = calls.map((call) => {
                        const args = (call.args ?? {}) as Record<string, unknown>;
                        let toolResult: Record<string, unknown> = { error: 'Tool is unavailable for this assistant.' };

                        if (call.name === 'book_appointment' && assistant.id !== MUNICIPALITY_ASSISTANT_ID) {
                          const appointment: Appointment = {
                            id: `appt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                            assistantId: assistant.id,
                            name: String(args.name ?? 'Caller'),
                            phone: String(args.phone ?? 'Not provided'),
                            datetime: String(args.datetime ?? 'Requested time'),
                            createdAt: new Date().toISOString(),
                          };
                          const s = getStore();
                          s.appointments.unshift(appointment);
                          saveStore();
                          toolResult = { status: 'confirmed', appointment };
                        } else if (call.name === 'transfer_to_human' && assistant.id !== MUNICIPALITY_ASSISTANT_ID) {
                          toolResult = {
                            status: 'transferring',
                            department: String(args.department ?? 'Front Desk'),
                          };
                        } else if (call.name === 'end_call') {
                          toolResult = {
                            status: 'ending_call',
                            reason: String(args.reason ?? 'Conversation complete'),
                          };
                        }

                        sendJson(clientWs, {
                          type: 'tool',
                          name: call.name,
                          args,
                          result: toolResult,
                        });

                        return {
                          id: call.id,
                          name: call.name,
                          response: toolResult,
                        };
                      });

                      try {
                        liveSession.sendToolResponse({ functionResponses });
                      } catch (err) {
                        console.error('Failed to send Live tool response:', err);
                      }
                    }
                  },
                  onerror: (err) => {
                    if (!accepted || isClosing) return;
                    markGeminiClientUnavailable(ai, new Error(err?.message || 'WebSocket error'));
                    sendJson(clientWs, {
                      type: 'error',
                      message: err?.message || 'Fedora Pilot connection error',
                    });
                  },
                  onclose: (ev) => {
                    if (!accepted || isClosing) return;
                    liveSession = null;
                    const code = ev?.code || 1000;
                    const reason = ev?.reason || '';
                    markGeminiClientUnavailable(ai, new Error(`WebSocket closed with code ${code}: ${reason}`));
                    sendJson(clientWs, { type: 'closed', reason, code });
                  },
                },
              });
              liveSession = await waitForLiveSession(connection, signal);
              accepted = true;
            },
            { apiVersion: 'v1beta', signal: connectionLifetime.signal },
          );
          sendJson(clientWs, { type: 'ready', model: modelUsed, chunksLoaded: kb.chunks.length });
        } catch (err) {
          if (!isClosing) {
            sendJson(clientWs, {
              type: 'error',
              message: err instanceof Error ? err.message : 'Unable to establish Fedora Pilot session.',
            });
          }
        } finally {
          isConnecting = false;
        }
        return;
      }

      if (msg.type === 'audio' && liveSession) {
        try {
          liveSession.sendRealtimeInput({
            audio: {
              data: msg.data,
              mimeType: 'audio/pcm;rate=16000',
            },
          });
        } catch (err) {
          console.error('Live sendRealtimeInput audio failed:', err);
        }
        return;
      }

      if (msg.type === 'text' && liveSession && msg.text.trim()) {
        try {
          liveSession.sendRealtimeInput({
            text: msg.text.trim(),
          });
        } catch (err) {
          console.error('Live sendRealtimeInput text failed:', err);
        }
      }
    });
  });
}
