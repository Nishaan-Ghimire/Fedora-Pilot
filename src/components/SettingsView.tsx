import { useEffect, useState, type FormEvent } from 'react';

type SettingsStatus = {
  hasApiKey: boolean;
  canManageApiKey: boolean;
  totalTokens: number;
};

const inputClassName =
  'w-full rounded-lg border border-slate-700 bg-[#111827] px-3 py-2 text-sm text-slate-100 focus-visible:outline-2 focus-visible:outline-sky-400';

export function SettingsView() {
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    async function loadSettings() {
      try {
        const response = await fetch('/api/settings', { signal: controller.signal });
        if (!response.ok) throw new Error('Could not load API settings.');
        setStatus(await response.json() as SettingsStatus);
      } catch {
        if (!controller.signal.aborted) setError('Could not load API settings.');
      }
    }
    void loadSettings();
    return () => controller.abort();
  }, []);

  async function saveApiKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const resetTokens = fields.has('resetTokens');
    setIsSaving(true);
    setError('');
    setConfirmation('');

    try {
      const response = await fetch('/api/settings/api-key', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: fields.get('apiKey'),
          password: fields.get('password'),
          resetTokens,
        }),
      });
      if (!response.ok) {
        const result = await response.json() as { error?: string };
        setError(result.error ?? 'Could not save the API key.');
        return;
      }
      setStatus(await response.json() as SettingsStatus);
      form.reset();
      setConfirmation(resetTokens ? 'API key saved and token count reset.' : 'API key saved.');
    } catch {
      setError('Could not save the API key.');
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-5 py-6 sm:px-8 sm:py-8">
      <h1 className="font-display text-2xl font-semibold text-slate-100">Settings</h1>
      <section
        aria-labelledby="api-settings-heading"
        className="mt-6 rounded-xl border border-slate-800 bg-[#0B101B] p-5 sm:p-6"
      >
        <h2 id="api-settings-heading" className="font-display text-lg font-semibold">
          Gemini API key
        </h2>
        {status ? (
          <>
            <dl className="my-5 grid gap-4 rounded-lg bg-slate-900/60 p-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-slate-400">API key status</dt>
                <dd className="mt-1 font-medium">
                  {status.hasApiKey ? 'Configured' : 'No key configured'}
                </dd>
              </div>
              <div>
                <dt className="text-slate-400">Reported tokens</dt>
                <dd className="mt-1 font-mono tabular-nums">{status.totalTokens.toLocaleString()}</dd>
              </div>
            </dl>
            {status.canManageApiKey ? (
              <form onSubmit={saveApiKey}>
                <fieldset disabled={isSaving} className="space-y-4">
                  <div>
                    <label htmlFor="settings-api-key" className="mb-1.5 block text-sm font-medium">
                      New API key
                    </label>
                    <input
                      id="settings-api-key"
                      name="apiKey"
                      type="password"
                      autoComplete="off"
                      maxLength={512}
                      className={inputClassName}
                      required
                    />
                  </div>
                  <div>
                    <label htmlFor="settings-password" className="mb-1.5 block text-sm font-medium">
                      Settings password
                    </label>
                    <input
                      id="settings-password"
                      name="password"
                      type="password"
                      autoComplete="current-password"
                      className={inputClassName}
                      required
                    />
                  </div>
                  <div>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        name="resetTokens"
                        aria-describedby="reset-tokens-help"
                        className="size-4 accent-sky-400"
                      />
                      Reset token count when saving
                    </label>
                    <p id="reset-tokens-help" className="mt-1 text-xs text-slate-400">
                      Clears the dashboard counter. Google manages API quotas separately.
                    </p>
                  </div>
                  <button
                    type="submit"
                    className="rounded-lg bg-sky-400 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-sky-300 disabled:opacity-60"
                  >
                    {isSaving ? 'Saving…' : 'Save API key'}
                  </button>
                </fieldset>
              </form>
            ) : (
              <p className="text-sm text-slate-400">
                Set <code>DASHBOARD_SETTINGS_PASSWORD</code> on the server to enable API key changes.
              </p>
            )}
          </>
        ) : !error && <p role="status" className="mt-3 text-sm text-slate-400">Loading API settings…</p>}
        {error && <p role="alert" className="mt-4 text-sm text-rose-300">{error}</p>}
        {confirmation && <p role="status" className="mt-4 text-sm text-emerald-300">{confirmation}</p>}
      </section>
    </div>
  );
}
