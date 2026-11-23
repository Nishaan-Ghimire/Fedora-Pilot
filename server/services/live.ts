import type { IncomingMessage } from 'node:http';
import { Modality, type LiveServerMessage } from '@google/genai';
import { WebSocket, WebSocketServer } from 'ws';
import { MODEL_CONFIG } from '../config/models.ts';
import type { Appointment } from '../../src/types.ts';
import { getGeminiBetaClient, isModelNotFoundError, recordGeminiUsage } from './gemini.ts';
import { getAllKnowledgeText } from './kb.ts';
import { buildAgentSystemInstruction, VOICE_TOOL_DECLARATIONS } from './prompts.ts';
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

export function attachLiveWebSocketServer(wss: WebSocketServer): void {
  wss.on('connection', (clientWs: WebSocket, _req: IncomingMessage) => {
    let liveSession: Awaited<ReturnType<ReturnType<typeof getGeminiBetaClient>['live']['connect']>> | null = null;
    let isClosing = false;
    let assistantId = 'aria-acme-dental';

    const cleanup = () => {
      if (isClosing) return;
      isClosing = true;
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
        if (liveSession) return;
        assistantId = msg.assistantId || 'aria-acme-dental';
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

        let ai;
        try {
          ai = getGeminiBetaClient();
        } catch (err) {
          sendJson(clientWs, {
            type: 'error',
            message: err instanceof Error ? err.message : 'Missing GEMINI_API_KEY',
          });
          return;
        }

        const candidates = [
          MODEL_CONFIG.LIVE_MODEL,
          ...MODEL_CONFIG.LIVE_FALLBACK_MODELS,
        ].filter((m, idx, arr) => Boolean(m) && arr.indexOf(m) === idx);

        let connectedModel = candidates[0];
        let lastErr: unknown = null;

        for (const model of candidates) {
          try {
            let opened = false;
            const session = await ai.live.connect({
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
                tools: [{ functionDeclarations: VOICE_TOOL_DECLARATIONS }],
              },
              callbacks: {
                onopen: () => {
                  opened = true;
                  if (liveSession) {
                    sendJson(clientWs, {
                      type: 'ready',
                      model,
                      chunksLoaded: kb.chunks.length,
                    });
                  }
                },
                onmessage: (message: LiveServerMessage) => {
                  recordGeminiUsage(ai, message.usageMetadata?.totalTokenCount);
                  if (isClosing) return;
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
                      let toolResult: Record<string, unknown> = { ok: true };

                      if (call.name === 'book_appointment') {
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
                      } else if (call.name === 'transfer_to_human') {
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
                  console.error('Fedora Pilot error:', err);
                  sendJson(clientWs, {
                    type: 'error',
                    message: err?.message || 'Fedora Pilot connection error',
                  });
                },
                onclose: (ev) => {
                  if (!isClosing) {
                    sendJson(clientWs, {
                      type: 'closed',
                      reason: ev?.reason || '',
                      code: ev?.code || 1000,
                    });
                  }
                },
              },
            });
            liveSession = session;
            connectedModel = model;
            if (opened) {
              sendJson(clientWs, {
                type: 'ready',
                model: connectedModel,
                chunksLoaded: kb.chunks.length,
              });
            }
            break;
          } catch (err) {
            lastErr = err;
            console.error(`Fedora Pilot connect failed for ${model}:`, err);
            if (!isModelNotFoundError(err)) {
              break;
            }
          }
        }

        if (!liveSession) {
          sendJson(clientWs, {
            type: 'error',
            message:
              lastErr instanceof Error
                ? lastErr.message
                : 'Unable to establish Fedora Pilot session.',
          });
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
