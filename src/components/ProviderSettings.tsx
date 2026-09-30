'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, post } from '@/lib/client';

type Provider = 'anthropic_api' | 'claude_subscription' | 'openai_subscription' | 'openai_api';

interface ProvidersData {
  current: Provider;
  statuses: { provider: Provider; ready: boolean; detail: string }[];
  canImportCodexLogin: boolean;
  chatgptLogin: { inProgress: boolean; error?: string; signedIn: boolean };
  claudeTokenSaved: boolean;
}

const LABELS: Record<Provider, { title: string; blurb: string }> = {
  claude_subscription: { title: 'Claude subscription', blurb: 'Pro or Max plan, via Claude Code' },
  anthropic_api: { title: 'Anthropic API key', blurb: 'Pay per token' },
  openai_subscription: { title: 'ChatGPT subscription', blurb: 'Plus or Pro plan, via Codex' },
  openai_api: { title: 'OpenAI API key', blurb: 'Pay per token, via Codex' },
};
const ORDER: Provider[] = ['claude_subscription', 'anthropic_api', 'openai_subscription', 'openai_api'];

const btn = 'rounded-md border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800';
const input = 'min-w-0 flex-1 rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-xs dark:border-zinc-700';

export function ProviderSettings({ onMessage }: { onMessage: (m: string) => void }) {
  const [d, setD] = useState<ProvidersData | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const load = useCallback(async () => setD(await api<ProvidersData>('/api/providers')), []);

  useEffect(() => {
    load().catch((e) => onMessage(e.message));
  }, [load, onMessage]);

  // While a ChatGPT sign-in is in progress, poll until Codex has written its login.
  useEffect(() => {
    if (!d?.chatgptLogin.inProgress) return;
    const t = setInterval(() => load().catch(() => {}), 2000);
    return () => clearInterval(t);
  }, [d?.chatgptLogin.inProgress, load]);

  const act = async (b: Record<string, unknown>) => {
    try {
      const r = await post<{ url?: string }>('/api/providers', b);
      if (r.url) window.open(r.url, '_blank', 'noopener');
      await load();
    } catch (e) {
      onMessage((e as Error).message);
    }
  };

  const secretForm = (action: string, placeholder: string) => (
    <form
      className="mt-1 flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        act({ action, value: values[action] ?? '' });
        setValues((v) => ({ ...v, [action]: '' }));
      }}
    >
      <input
        type="password"
        placeholder={placeholder}
        className={input}
        value={values[action] ?? ''}
        onChange={(e) => setValues((v) => ({ ...v, [action]: e.target.value }))}
        data-testid={`provider-input-${action}`}
      />
      <button className={btn}>Save</button>
    </form>
  );

  if (!d) return null;
  return (
    <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800" data-testid="provider-settings">
      <h2 className="mb-1 font-semibold">Model provider</h2>
      <p className="mb-3 text-xs text-zinc-500">
        Choose which account powers Poppet. Subscriptions use your own plan's limits and are for your personal use of your own
        account.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {ORDER.map((p) => {
          const st = d.statuses.find((x) => x.provider === p)!;
          const selected = d.current === p;
          return (
            <div
              key={p}
              data-testid={`provider-${p}`}
              data-selected={selected}
              className={`rounded-md border p-3 ${selected ? 'border-zinc-900 dark:border-zinc-100' : 'border-zinc-200 dark:border-zinc-800'}`}
            >
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="radio"
                  name="provider"
                  checked={selected}
                  onChange={() => {
                    setD({ ...d, current: p });
                    act({ action: 'select', provider: p });
                  }}
                  className="mt-1"
                />
                <span>
                  <span className="block font-medium">{LABELS[p].title}</span>
                  <span className="block text-xs text-zinc-500">{LABELS[p].blurb}</span>
                </span>
                <span
                  className={`ml-auto text-xs ${st.ready ? 'text-green-700 dark:text-green-400' : 'text-amber-700 dark:text-amber-400'}`}
                >
                  {st.ready ? 'ready' : 'setup needed'}
                </span>
              </label>
              <p className="mt-1 text-xs text-zinc-500" data-testid={`provider-detail-${p}`}>
                {st.detail}
              </p>
              {p === 'anthropic_api' && secretForm('set_anthropic_key', 'sk-ant-…')}
              {p === 'claude_subscription' && (
                <>
                  {secretForm(
                    'set_claude_token',
                    d.claudeTokenSaved ? 'Replace token from `claude setup-token`' : 'Optional: token from `claude setup-token`',
                  )}
                  {d.claudeTokenSaved && (
                    <button className={`${btn} mt-1`} onClick={() => act({ action: 'set_claude_token', value: '' })}>
                      Remove token (use local login)
                    </button>
                  )}
                </>
              )}
              {p === 'openai_subscription' && (
                <div className="mt-1 flex flex-wrap gap-2">
                  {!d.chatgptLogin.signedIn && (
                    <button className={btn} onClick={() => act({ action: 'chatgpt_login' })} data-testid="chatgpt-login">
                      {d.chatgptLogin.inProgress ? 'Waiting for sign-in…' : 'Sign in with ChatGPT'}
                    </button>
                  )}
                  {d.canImportCodexLogin && (
                    <button className={btn} onClick={() => act({ action: 'chatgpt_import' })}>
                      Use existing Codex login
                    </button>
                  )}
                  {d.chatgptLogin.signedIn && (
                    <button className={btn} onClick={() => act({ action: 'chatgpt_logout' })}>
                      Sign out
                    </button>
                  )}
                  {d.chatgptLogin.error && <span className="text-xs text-red-600">{d.chatgptLogin.error}</span>}
                </div>
              )}
              {p === 'openai_api' && secretForm('set_openai_key', 'sk-…')}
            </div>
          );
        })}
      </div>
    </section>
  );
}
