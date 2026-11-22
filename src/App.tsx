import { useCallback, useEffect, useState } from 'react';
import { AssistantsView } from './components/AssistantsView';
import { CallLogsView } from './components/CallLogsView';
import { DialerView } from './components/DialerView';
import { KnowledgeView } from './components/KnowledgeView';
import { Sidebar, type NavTab } from './components/Sidebar';
import { ToastStack, type ToastMessage } from './components/Toast';
import type { AgentMode, Appointment, Assistant, CallLog } from './types';

export default function App() {
  const [activeTab, setActiveTab] = useState<NavTab>('dialer');
  const [assistants, setAssistants] = useState<Assistant[]>([]);
  const [selectedAssistantId, setSelectedAssistantId] = useState<string>(
    'anita-himalayan-dental-np'
  );
  const [calls, setCalls] = useState<CallLog[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const notify = useCallback(
    (type: 'error' | 'success' | 'info', title: string, detail?: string) => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      setToasts((prev) => [...prev.slice(-3), { id, type, title, detail }]);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 5500);
    },
    []
  );

  const loadBootstrap = useCallback(async () => {
    setIsLoading(true);
    try {
      const [astRes, callsRes, apptsRes] = await Promise.all([
        fetch('/api/assistants'),
        fetch('/api/calls'),
        fetch('/api/appointments'),
      ]);
      const astData = (await astRes.json()) as { assistants?: Assistant[] };
      const callsData = (await callsRes.json()) as { calls?: CallLog[] };
      const apptsData = (await apptsRes.json()) as { appointments?: Appointment[] };

      const list = astData.assistants ?? [];
      setAssistants(list);
      if (list.length > 0) {
        setSelectedAssistantId((prev) =>
          list.some((a) => a.id === prev) ? prev : list[0].id
        );
      }
      setCalls(callsData.calls ?? []);
      setAppointments(apptsData.appointments ?? []);
    } catch {
      notify('error', 'Failed to load workspace data', 'Ensure the backend server is running.');
    } finally {
      setIsLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void loadBootstrap();
  }, [loadBootstrap]);

  const activeAssistant =
    assistants.find((a) => a.id === selectedAssistantId) ?? assistants[0];

  const handleSaveAssistant = async (
    draft: Partial<Assistant>
  ): Promise<Assistant | null> => {
    try {
      const res = await fetch('/api/assistants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      const data = (await res.json()) as { assistant?: Assistant; error?: string };
      if (!res.ok || !data.assistant) {
        throw new Error(data.error || 'Could not save assistant');
      }
      const saved = data.assistant;
      setAssistants((prev) => {
        const exists = prev.some((a) => a.id === saved.id);
        return exists
          ? prev.map((a) => (a.id === saved.id ? saved : a))
          : [...prev, saved];
      });
      return saved;
    } catch (err) {
      notify(
        'error',
        'Save failed',
        err instanceof Error ? err.message : 'Unable to save assistant.'
      );
      return null;
    }
  };

  const handleDeleteAssistant = async (id: string) => {
    try {
      const res = await fetch(`/api/assistants/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error || 'Delete failed');
      setAssistants((prev) => {
        const next = prev.filter((a) => a.id !== id);
        if (next.length > 0 && selectedAssistantId === id) {
          setSelectedAssistantId(next[0].id);
        }
        return next;
      });
      notify('info', 'Assistant deleted');
    } catch (err) {
      notify(
        'error',
        'Delete failed',
        err instanceof Error ? err.message : 'Unable to delete assistant.'
      );
    }
  };

  const handleSwitchMode = async (mode: AgentMode) => {
    if (!activeAssistant || activeAssistant.mode === mode) return;
    await handleSaveAssistant({ ...activeAssistant, mode });
    notify(
      'info',
      mode === 'pipeline' ? 'Switched to Pipeline Mode' : 'Switched to Realtime Mode',
      mode === 'pipeline'
        ? 'STT -> RAG -> Streaming LLM -> Sentence-chunked 24kHz TTS'
        : 'Bidirectional Gemini Live Audio API over WebSocket'
    );
  };

  const handleToggleGreetFirst = async () => {
    if (!activeAssistant) return;
    const nextGreetFirst = !(activeAssistant.greetFirst ?? true);
    await handleSaveAssistant({ ...activeAssistant, greetFirst: nextGreetFirst });
    notify(
      'info',
      nextGreetFirst ? 'Post-ring greeting enabled' : 'Post-ring greeting disabled',
      nextGreetFirst
        ? 'Assistant will greet immediately after ringing.'
        : 'Assistant will wait for the caller to speak first.'
    );
  };

  const refreshCalls = async () => {
    try {
      const res = await fetch('/api/calls');
      const data = (await res.json()) as { calls?: CallLog[] };
      setCalls(data.calls ?? []);
    } catch {
      notify('error', 'Failed to refresh call logs');
    }
  };

  return (
    <div className="min-h-screen bg-[#090D16] text-slate-100 flex flex-col lg:flex-row">
      <Sidebar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        assistants={assistants}
        selectedAssistantId={selectedAssistantId}
        onSelectAssistant={setSelectedAssistantId}
        callCount={calls.length}
      />

      <main className="flex-1 min-w-0 overflow-y-auto">
        {isLoading || !activeAssistant ? (
          <div className="p-8 text-sm text-slate-400">
            Loading Fedora-Pilot workspace...
          </div>
        ) : (
          <>
            {activeTab === 'assistants' && (
              <AssistantsView
                assistants={assistants}
                selectedAssistantId={activeAssistant.id}
                onSelectAssistant={setSelectedAssistantId}
                onSaveAssistant={handleSaveAssistant}
                onDeleteAssistant={handleDeleteAssistant}
                onGoToDialer={() => setActiveTab('dialer')}
                onNotify={notify}
              />
            )}

            {activeTab === 'knowledge' && (
              <KnowledgeView
                assistant={activeAssistant}
                onUpdateAssistant={handleSaveAssistant}
                onNotify={notify}
              />
            )}

            {activeTab === 'dialer' && (
              <DialerView
                assistant={activeAssistant}
                appointments={appointments}
                onSwitchMode={handleSwitchMode}
                onToggleGreetFirst={() => void handleToggleGreetFirst()}
                onAppointmentCreated={(appt) =>
                  setAppointments((prev) => [appt, ...prev])
                }
                onCallSaved={(call) => setCalls((prev) => [call, ...prev])}
                onNotify={notify}
              />
            )}

            {activeTab === 'logs' && (
              <CallLogsView calls={calls} onRefresh={() => void refreshCalls()} />
            )}
          </>
        )}
      </main>

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
