'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, post } from '@/lib/client';

interface SettingsData {
  google: Record<'personal' | 'agent', { connected: boolean; email?: string }>;
  googleConfigured: boolean;
  reddit: { configured: boolean };
  sandbox: { driver: string; available: boolean };
  model: string;
  integrations: { name: string; registryName: string; transport: string; url?: string; package?: string; connected: boolean; auth: { type: string } }[];
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
}

interface RegistryData {
  items: { id: string; kind: string; name: string; version: number; status: string; createdAt: number; failures: number }[];
  active: { skills: string[]; tools: string[]; mcp: string[] };
  grants: Record<string, string[]>;
  history: { sha: string; message: string; date: string }[];
}

const section = 'rounded-lg border border-zinc-200 p-4 dark:border-zinc-800';
const btn = 'rounded-md border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800';

export function Settings() {
  const [s, setS] = useState<SettingsData | null>(null);
  const [reg, setReg] = useState<RegistryData | null>(null);
  const [memories, setMemories] = useState<{ id: number; text: string; tags: string; createdAt: number }[]>([]);
  const [audit, setAudit] = useState<{ id: number; event: string; convId: string | null; detail: unknown; createdAt: number }[]>([]);
  const [secretNames, setSecretNames] = useState<string[]>([]);
  const [source, setSource] = useState<Record<string, string> | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [newSecret, setNewSecret] = useState({ name: '', value: '' });

  const load = useCallback(async () => {
    const [a, b, c, d, e] = await Promise.all([
      api<SettingsData>('/api/settings'),
      api<RegistryData>('/api/registry'),
      api<{ memories: typeof memories }>('/api/memories'),
      api<{ entries: typeof audit }>('/api/audit'),
      api<{ names: string[] }>('/api/secrets'),
    ]);
    setS(a);
    setReg(b);
    setMemories(c.memories);
    setAudit(d.entries);
    setSecretNames(e.names);
  }, []);

  useEffect(() => {
    load().catch((e) => setMsg(e.message));
    const q = new URLSearchParams(window.location.search);
    if (q.get('error')) setMsg(q.get('error'));
    else if (q.get('connected')) setMsg(`Connected ${q.get('connected')}.`);
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const registryAction = (action: string, kind: string, name: string) =>
    act(async () => {
      if (action === 'delete' && !confirm(`Delete ${kind} ${name}? (It stays in git history.)`)) return;
      await post('/api/registry', { action, kind, name });
    });

  const kinds: [string, string, string[]][] = reg
    ? [
        ['skill', 'Skills', reg.active.skills],
        ['tool', 'Agent-written tools', reg.active.tools],
        ['mcp', 'Integrations', reg.active.mcp],
      ]
    : [];

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 text-sm">
      <div className="flex items-center gap-3">
        <Link href="/" className="underline">
          ← Chat
        </Link>
        <h1 className="text-lg font-semibold">Settings</h1>
      </div>
      {msg && (
        <div className="rounded-md bg-zinc-100 px-3 py-2 dark:bg-zinc-800" role="status">
          {msg}
        </div>
      )}

      <section className={section}>
        <h2 className="mb-2 font-semibold">Connected accounts</h2>
        {s && (
          <ul className="space-y-2">
            {(['personal', 'agent'] as const).map((a) => (
              <li key={a} className="flex items-center gap-2" data-testid={`account-${a}`}>
                <span className="w-44">{a === 'personal' ? 'Google (personal)' : 'Google (agent inbox)'}</span>
                <span className="text-zinc-500">{s.google[a].connected ? (s.google[a].email ?? 'connected') : 'not connected'}</span>
                <span className="ml-auto flex gap-2">
                  <a className={btn} href={`/api/oauth/google/start?account=${a}`}>
                    {s.google[a].connected ? 'Reconnect' : 'Connect'}
                  </a>
                  {s.google[a].connected && (
                    <button className={btn} onClick={() => act(() => post('/api/settings', { action: 'disconnect_google', account: a }))}>
                      Disconnect
                    </button>
                  )}
                </span>
              </li>
            ))}
            <li className="flex items-center gap-2">
              <span className="w-44">Reddit API</span>
              <span className="text-zinc-500">{s.reddit.configured ? 'configured (read-only)' : 'not configured — set REDDIT_CLIENT_ID / SECRET'}</span>
            </li>
            <li className="flex items-center gap-2">
              <span className="w-44">Sandbox</span>
              <span className="text-zinc-500">
                {s.sandbox.driver} · {s.sandbox.available ? 'available' : 'unavailable'}
              </span>
            </li>
            {!s.googleConfigured && <li className="text-xs text-amber-700">Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to connect Google.</li>}
            <li className="text-xs text-zinc-500">
              Total usage: {(s.usage.inputTokens + s.usage.outputTokens).toLocaleString()} tokens · ${s.usage.costUsd.toFixed(4)}
            </li>
          </ul>
        )}
      </section>

      <section className={section}>
        <h2 className="mb-2 font-semibold">Installed skills, tools and integrations</h2>
        {kinds.map(([kind, label, active]) => {
          const names = [...new Set(reg!.items.filter((i) => i.kind === kind && !['rejected', 'deleted', 'pending'].includes(i.status)).map((i) => i.name))];
          return (
            <div key={kind} className="mb-3">
              <h3 className="mb-1 text-xs font-semibold uppercase text-zinc-500">{label}</h3>
              {names.length === 0 && <p className="text-xs text-zinc-500">None yet.</p>}
              <ul className="space-y-1">
                {names.map((name) => {
                  const latest = reg!.items.filter((i) => i.kind === kind && i.name === name).sort((a, b) => b.version - a.version)[0];
                  const on = active.includes(name);
                  const integ = kind === 'mcp' ? s?.integrations.find((x) => x.name === name) : undefined;
                  return (
                    <li key={name} className="flex flex-wrap items-center gap-2" data-testid={`registry-${kind}-${name}`}>
                      <span className="font-medium">{kind === 'tool' ? `sandbox_tool_${name}` : name}</span>
                      <span className="text-xs text-zinc-500">
                        v{latest.version} · {on ? latest.status : 'disabled'}
                        {kind === 'tool' && reg!.grants[name]?.length ? ` · secrets: ${reg!.grants[name].join(', ')}` : ''}
                        {integ ? ` · ${integ.connected ? 'connected' : 'not signed in'}` : ''}
                      </span>
                      <span className="ml-auto flex gap-1">
                        {integ && !integ.connected && integ.auth.type === 'oauth' && (
                          <a className={btn} href={`/api/integrations/${name}/signin`} target="_blank" rel="noreferrer">
                            Sign in
                          </a>
                        )}
                        <button className={btn} onClick={() => api(`/api/registry?kind=${kind}&name=${name}`).then((r) => setSource(r.source))}>
                          Source
                        </button>
                        <button className={btn} onClick={() => registryAction(on ? 'disable' : 'enable', kind, name)}>
                          {on ? 'Disable' : 'Enable'}
                        </button>
                        <button className={btn} onClick={() => registryAction('rollback', kind, name)}>
                          Roll back
                        </button>
                        <button className={btn} onClick={() => registryAction('delete', kind, name)}>
                          Delete
                        </button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
        {source && (
          <div className="mt-2 rounded-md border border-zinc-200 p-2 dark:border-zinc-800">
            <button className="float-right text-xs underline" onClick={() => setSource(null)}>
              Close
            </button>
            {Object.entries(source).map(([file, content]) => (
              <div key={file} className="mb-2">
                <div className="text-xs font-semibold">{file}</div>
                <pre className="max-h-72 overflow-auto rounded bg-zinc-100 p-2 text-xs dark:bg-zinc-900">{content}</pre>
              </div>
            ))}
          </div>
        )}
        {reg && reg.history.length > 0 && (
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-zinc-500">Registry git history</summary>
            <ul className="mt-1 space-y-0.5 text-xs">
              {reg.history.map((h) => (
                <li key={h.sha}>
                  <code>{h.sha.slice(0, 7)}</code> {h.message} <span className="text-zinc-500">{new Date(h.date).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className={section}>
        <h2 className="mb-2 font-semibold">Secrets for agent-written tools</h2>
        <p className="mb-2 text-xs text-zinc-500">Stored in the Keychain. A tool only receives a secret after you approve a grant.</p>
        <ul className="mb-2 space-y-1">
          {secretNames.map((n) => (
            <li key={n} className="flex items-center gap-2">
              <code>{n}</code>
              <button className={btn} onClick={() => act(() => api(`/api/secrets?name=${encodeURIComponent(n)}`, { method: 'DELETE' }))}>
                Delete
              </button>
            </li>
          ))}
        </ul>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            act(async () => {
              await post('/api/secrets', newSecret);
              setNewSecret({ name: '', value: '' });
            });
          }}
        >
          <input
            placeholder="NAME"
            value={newSecret.name}
            onChange={(e) => setNewSecret((v) => ({ ...v, name: e.target.value }))}
            className="w-40 rounded-md border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
          />
          <input
            placeholder="value"
            type="password"
            value={newSecret.value}
            onChange={(e) => setNewSecret((v) => ({ ...v, value: e.target.value }))}
            className="flex-1 rounded-md border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
          />
          <button className={btn}>Add</button>
        </form>
      </section>

      <section className={section}>
        <h2 className="mb-2 font-semibold">Memories</h2>
        {memories.length === 0 && <p className="text-xs text-zinc-500">No memories yet.</p>}
        <ul className="space-y-1" data-testid="memories">
          {memories.map((m) => (
            <li key={m.id} className="flex items-start gap-2">
              <span className="flex-1">{m.text}</span>
              <button className={btn} onClick={() => act(() => api(`/api/memories?id=${m.id}`, { method: 'DELETE' }))}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className={section}>
        <h2 className="mb-2 font-semibold">Audit log</h2>
        <div className="max-h-96 overflow-y-auto">
          <table className="w-full text-xs" data-testid="audit-log">
            <tbody>
              {audit.map((a) => (
                <tr key={a.id} className="border-t border-zinc-100 align-top dark:border-zinc-900">
                  <td className="whitespace-nowrap py-1 pr-2 text-zinc-500">{new Date(a.createdAt).toLocaleString()}</td>
                  <td className="py-1 pr-2 font-medium">{a.event}</td>
                  <td className="py-1">
                    <code className="break-all text-[11px] text-zinc-600 dark:text-zinc-400">{JSON.stringify(a.detail).slice(0, 300)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
