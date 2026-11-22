import { Bot, BookOpen, History, PhoneCall } from 'lucide-react';
import type { Assistant } from '../types';

export type NavTab = 'assistants' | 'knowledge' | 'dialer' | 'logs';

interface SidebarProps {
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  assistants: Assistant[];
  selectedAssistantId: string;
  onSelectAssistant: (id: string) => void;
  callCount: number;
}

const NAV_ITEMS: Array<{
  id: NavTab;
  label: string;
  icon: typeof Bot;
}> = [
  { id: 'assistants', label: 'Assistants', icon: Bot },
  { id: 'knowledge', label: 'Knowledge', icon: BookOpen },
  { id: 'dialer', label: 'Dialer', icon: PhoneCall },
  { id: 'logs', label: 'Call Logs', icon: History },
];

export function Sidebar({
  activeTab,
  onSelectTab,
  assistants,
  selectedAssistantId,
  onSelectAssistant,
  callCount,
}: SidebarProps) {
  const selectedAssistant =
    assistants.find((a) => a.id === selectedAssistantId) ?? assistants[0];

  return (
    <aside className="w-full lg:w-64 shrink-0 border-b lg:border-b-0 lg:border-r border-slate-800/80 bg-[#0B101B] flex flex-col justify-between">
      <div>
        {/* Brand Header */}
        <div className="px-5 py-5 border-b border-slate-800/80 flex items-center justify-between lg:block">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-sky-500/15 border border-sky-500/30 flex items-center justify-center text-sky-400 font-display font-bold text-sm">
              FP
            </div>
            <span className="font-display font-semibold text-base tracking-tight text-slate-100 whitespace-nowrap">
              Fedora-Pilot
            </span>
          </div>
          <p className="hidden lg:block mt-1.5 text-xs text-slate-400">
            Voice AI Agent Studio
          </p>
        </div>

        {/* Navigation Links */}
        <nav
          aria-label="Primary"
          className="px-3 py-3 flex lg:flex-col gap-1 overflow-x-auto"
        >
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectTab(item.id)}
                className={`flex items-center justify-between gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  isActive
                    ? 'bg-slate-800/90 text-white'
                    : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/40'
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <Icon
                    className={`w-4 h-4 shrink-0 ${
                      isActive ? 'text-sky-400' : 'text-slate-400'
                    }`}
                  />
                  <span>{item.label}</span>
                </span>
                {item.id === 'logs' && callCount > 0 && (
                  <span className="text-xs font-mono tabular-nums text-slate-400">
                    {callCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Active Assistant Switcher */}
      <div className="hidden lg:block p-4 border-t border-slate-800/80">
        <label
          htmlFor="sidebar-assistant-select"
          className="block text-xs font-medium text-slate-400 mb-2"
        >
          Active Dialer Target
        </label>
        <select
          id="sidebar-assistant-select"
          value={selectedAssistant?.id ?? ''}
          onChange={(e) => onSelectAssistant(e.target.value)}
          className="w-full rounded-lg bg-[#111827] border border-slate-800 px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-sky-500/70"
        >
          {assistants.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} — {a.companyName}
            </option>
          ))}
        </select>
        {selectedAssistant && (
          <div className="mt-2.5 text-xs text-slate-400 space-y-1">
            <div className="flex items-center justify-between">
              <span>Mode</span>
              <span className="font-mono text-slate-200">
                {selectedAssistant.mode === 'pipeline' ? 'Pipeline' : 'Realtime'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span>Voice</span>
              <span className="font-mono text-slate-200">{selectedAssistant.voice}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Line</span>
              <span className="font-mono tabular-nums text-slate-300">
                {selectedAssistant.phoneNumber}
              </span>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
