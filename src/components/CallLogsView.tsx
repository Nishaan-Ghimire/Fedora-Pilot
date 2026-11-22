import { useState } from 'react';
import {
  AlertTriangle,
  CalendarCheck2,
  ChevronDown,
  ChevronRight,
  Clock,
  PhoneForwarded,
  PhoneIncoming,
} from 'lucide-react';
import type { CallLog } from '../types';

interface CallLogsViewProps {
  calls: CallLog[];
  onRefresh: () => void;
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function CallLogsView({ calls, onRefresh }: CallLogsViewProps) {
  const [expandedId, setExpandedId] = useState<string | null>(calls[0]?.id ?? null);

  return (
    <div className="max-w-6xl mx-auto p-6 lg:p-8 space-y-6">
      <div className="flex items-center justify-between gap-4 pb-5 border-b border-slate-800/80">
        <div>
          <h1 className="text-2xl font-display font-semibold text-slate-100">
            Call Logs
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Recorded demo conversations with automated LLM call summaries, outcomes, and turn-by-turn latency.
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="px-4 py-2 rounded-lg border border-slate-700 bg-[#111827] hover:bg-slate-800 text-xs font-medium text-slate-200 transition-colors cursor-pointer"
        >
          Refresh Logs
        </button>
      </div>

      {calls.length === 0 ? (
        <div className="rounded-xl border border-slate-800/80 bg-[#111827] p-12 text-center space-y-2">
          <PhoneIncoming className="w-8 h-8 text-slate-500 mx-auto mb-2" />
          <p className="text-base font-medium text-slate-200">No calls recorded yet</p>
          <p className="text-sm text-slate-400 max-w-md mx-auto">
            Place a call in the Dialer screen. When you hang up, the transcript, per-turn latency metrics, and AI summary are saved here automatically.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {calls.map((call) => {
            const isExpanded = expandedId === call.id;
            const avgLatency =
              call.turnMetrics.length > 0
                ? Math.round(
                    call.turnMetrics.reduce((s, m) => s + m.totalLatencyMs, 0) /
                      call.turnMetrics.length
                  )
                : null;
            const hasSlowTurn = call.turnMetrics.some((m) => m.totalLatencyMs > 1500);

            return (
              <div
                key={call.id}
                className="rounded-xl border border-slate-800/80 bg-[#111827] overflow-hidden"
              >
                <button
                  type="button"
                  onClick={() => setExpandedId(isExpanded ? null : call.id)}
                  className="w-full px-5 py-4 flex flex-col md:flex-row md:items-center justify-between gap-3 text-left hover:bg-slate-800/25 transition-colors cursor-pointer"
                >
                  <div className="flex items-start gap-3 min-w-0">
                    {isExpanded ? (
                      <ChevronDown className="w-4 h-4 text-slate-400 mt-1 shrink-0" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-slate-400 mt-1 shrink-0" />
                    )}
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-slate-100">
                          {call.assistantName}
                        </span>
                        <span aria-hidden="true" className="text-slate-600">·</span>
                        <span className="text-xs font-mono tabular-nums text-slate-300">
                          {call.phoneNumber}
                        </span>
                        <span aria-hidden="true" className="text-slate-600">·</span>
                        <span className="text-xs text-sky-400 font-medium">
                          {call.mode === 'pipeline' ? 'Pipeline' : 'Realtime'}
                        </span>
                        <span aria-hidden="true" className="text-slate-600">·</span>
                        <span className="text-xs text-slate-300">{call.outcome}</span>
                      </div>
                      <p className="mt-1 text-xs text-slate-400 line-clamp-1">
                        {call.summary}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-5 shrink-0 pl-7 md:pl-0 text-xs">
                    <div className="flex items-center gap-1.5 text-slate-300 font-mono tabular-nums">
                      <Clock className="w-3.5 h-3.5 text-slate-400" />
                      <span>{formatDuration(call.durationSec)}</span>
                    </div>
                    {avgLatency !== null && (
                      <div
                        className={`font-mono tabular-nums ${
                          hasSlowTurn || avgLatency > 1500
                            ? 'text-rose-400'
                            : 'text-emerald-400'
                        }`}
                      >
                        avg {avgLatency} ms
                      </div>
                    )}
                    <span className="text-slate-500 font-mono tabular-nums">
                      {new Date(call.startedAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                </button>

                {isExpanded && (
                  <div className="border-t border-slate-800/80 p-5 space-y-5 bg-[#0B101B]/60">
                    {/* Summary & Outcomes */}
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                      <div className="lg:col-span-2 rounded-lg border border-slate-800 bg-[#090D16] p-4">
                        <p className="text-xs font-medium text-slate-400 mb-1">
                          Post-Call AI Summary
                        </p>
                        <p className="text-sm text-slate-200 leading-relaxed">
                          {call.summary}
                        </p>
                      </div>
                      <div className="rounded-lg border border-slate-800 bg-[#090D16] p-4 space-y-2">
                        <p className="text-xs font-medium text-slate-400">
                          Detected Outcome
                        </p>
                        <p className="text-sm font-semibold text-sky-300">
                          {call.outcome}
                        </p>
                        {call.appointmentsBooked.length > 0 && (
                          <div className="pt-2 border-t border-slate-800 space-y-1">
                            {call.appointmentsBooked.map((appt) => (
                              <div
                                key={appt.id}
                                className="flex items-center gap-1.5 text-xs text-emerald-300"
                              >
                                <CalendarCheck2 className="w-3.5 h-3.5 shrink-0" />
                                <span>
                                  {appt.name} · {appt.datetime}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                        {call.transfers.length > 0 && (
                          <div className="pt-2 border-t border-slate-800 space-y-1">
                            {call.transfers.map((tr, idx) => (
                              <div
                                key={idx}
                                className="flex items-center gap-1.5 text-xs text-amber-300"
                              >
                                <PhoneForwarded className="w-3.5 h-3.5 shrink-0" />
                                <span>Transferred to {tr.department}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Per-turn Latency Table */}
                    {call.turnMetrics.length > 0 && (
                      <div className="rounded-lg border border-slate-800 bg-[#090D16] overflow-x-auto">
                        <div className="px-4 py-2.5 border-b border-slate-800 text-xs font-medium text-slate-300">
                          Per-Turn Latency Breakdown
                        </div>
                        <table className="w-full text-left text-xs">
                          <thead className="text-slate-400 border-b border-slate-800/80">
                            <tr>
                              <th className="py-2.5 px-4 font-medium">Turn</th>
                              <th className="py-2.5 px-3 font-medium">Caller Input</th>
                              <th className="py-2.5 px-3 font-medium text-right">Endpointing</th>
                              <th className="py-2.5 px-3 font-medium text-right">Retrieval</th>
                              <th className="py-2.5 px-3 font-medium text-right">LLM TTFT</th>
                              <th className="py-2.5 px-3 font-medium text-right">TTS TTFA</th>
                              <th className="py-2.5 px-4 font-medium text-right">Total</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-800/60">
                            {call.turnMetrics.map((m) => {
                              const isSlow = m.totalLatencyMs > 1500;
                              return (
                                <tr key={m.turnIndex} className="hover:bg-slate-800/20">
                                  <td className="py-2.5 px-4 font-mono tabular-nums text-slate-400">
                                    #{m.turnIndex}
                                  </td>
                                  <td className="py-2.5 px-3 text-slate-200 max-w-xs truncate">
                                    {m.userText}
                                  </td>
                                  <td className="py-2.5 px-3 font-mono tabular-nums text-right text-slate-300">
                                    {m.endpointingDelayMs} ms
                                  </td>
                                  <td className="py-2.5 px-3 font-mono tabular-nums text-right text-slate-300">
                                    {m.retrievalMs} ms
                                  </td>
                                  <td className="py-2.5 px-3 font-mono tabular-nums text-right text-slate-300">
                                    {m.llmTtftMs} ms
                                  </td>
                                  <td className="py-2.5 px-3 font-mono tabular-nums text-right text-slate-300">
                                    {m.ttsTtfaMs} ms
                                  </td>
                                  <td
                                    className={`py-2.5 px-4 font-mono tabular-nums text-right font-semibold ${
                                      isSlow ? 'text-rose-400' : 'text-emerald-400'
                                    }`}
                                  >
                                    <span className="inline-flex items-center gap-1 justify-end">
                                      {isSlow && <AlertTriangle className="w-3 h-3" />}
                                      {m.totalLatencyMs} ms
                                    </span>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {/* Full Transcript */}
                    <div className="rounded-lg border border-slate-800 bg-[#090D16] p-4 space-y-2.5">
                      <p className="text-xs font-medium text-slate-400">
                        Full Call Transcript
                      </p>
                      <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                        {call.transcript
                          .filter((t) => !t.isInterim)
                          .map((entry) => (
                            <div key={entry.id} className="text-xs leading-relaxed">
                              <span
                                className={`font-semibold mr-2 ${
                                  entry.role === 'user'
                                    ? 'text-sky-400'
                                    : entry.role === 'agent'
                                      ? 'text-emerald-400'
                                      : 'text-amber-400'
                                }`}
                              >
                                {entry.role === 'user'
                                  ? 'Caller'
                                  : entry.role === 'agent'
                                    ? call.assistantName
                                    : 'System'}
                                :
                              </span>
                              <span className="text-slate-200">{entry.text}</span>
                              {entry.interrupted && (
                                <span className="ml-2 text-amber-400 font-mono text-[11px]">
                                  [interrupted]
                                </span>
                              )}
                            </div>
                          ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
