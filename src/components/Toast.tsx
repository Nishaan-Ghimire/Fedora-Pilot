import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';

export interface ToastMessage {
  id: string;
  type: 'error' | 'success' | 'info';
  title: string;
  detail?: string;
}

interface ToastStackProps {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}

export function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="fixed bottom-5 right-5 z-50 flex flex-col gap-2.5 max-w-sm w-full pointer-events-none"
    >
      {toasts.map((toast) => {
        const styles =
          toast.type === 'error'
            ? 'border-rose-500/40 bg-[#181018]/95 text-rose-100'
            : toast.type === 'success'
              ? 'border-emerald-500/40 bg-[#0F1B17]/95 text-emerald-100'
              : 'border-sky-500/40 bg-[#0F172A]/95 text-sky-100';

        const Icon =
          toast.type === 'error'
            ? AlertCircle
            : toast.type === 'success'
              ? CheckCircle2
              : Info;

        const iconColor =
          toast.type === 'error'
            ? 'text-rose-400'
            : toast.type === 'success'
              ? 'text-emerald-400'
              : 'text-sky-400';

        return (
          <div
            key={toast.id}
            className={`pointer-events-auto flex items-start gap-3 rounded-lg border px-4 py-3 shadow-lg backdrop-blur-md transition-all duration-200 ${styles}`}
          >
            <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${iconColor}`} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium leading-snug">{toast.title}</p>
              {toast.detail && (
                <p className="mt-0.5 text-xs opacity-80 leading-relaxed break-words">
                  {toast.detail}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => onDismiss(toast.id)}
              aria-label="Dismiss notification"
              className="shrink-0 text-slate-400 hover:text-slate-100 transition-colors p-0.5"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
