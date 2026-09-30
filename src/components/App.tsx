'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, post } from '@/lib/client';
import type { PoppetEvent, TimelineItem } from '@/server/events';
import { TimelineView } from './Timeline';
import { ArtifactsPanel } from './Artifacts';

interface Conv {
  id: string;
  title: string;
  updatedAt: number;
  running?: boolean;
}
interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export function App() {
  const [convs, setConvs] = useState<Conv[]>([]);
  const [convId, setConvId] = useState<string | null>(null);
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [turn, setTurn] = useState<'idle' | 'running' | 'retrying'>('idle');
  const [usage, setUsage] = useState<Usage | null>(null);
  const [input, setInput] = useState('');
  const [models, setModels] = useState<{ id: string; label: string }[]>([]);
  const [model, setModel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showArtifacts, setShowArtifacts] = useState(true);
  const bottom = useRef<HTMLDivElement>(null);

  const loadConvs = useCallback(async () => {
    const r = await api<{ conversations: Conv[] }>('/api/conversations');
    setConvs(r.conversations);
    return r.conversations;
  }, []);

  // Pick the conversation from the URL hash, else the most recent one.
  useEffect(() => {
    loadConvs().then((list) => {
      const fromHash = window.location.hash.slice(1);
      setConvId(fromHash && list.some((c) => c.id === fromHash) ? fromHash : (list[0]?.id ?? null));
    });
    const q = new URLSearchParams(window.location.search);
    if (q.get('error')) setError(q.get('error'));
  }, [loadConvs]);

  useEffect(() => {
    if (convId) history.replaceState(null, '', `/#${convId}`);
  }, [convId]);

  // Model choices depend on the selected provider (Claude or Codex models).
  useEffect(() => {
    api<{ models: { id: string; label: string }[] }>('/api/providers')
      .then((r) => {
        setModels(r.models);
        setModel(r.models[0]?.id ?? '');
      })
      .catch(() => {});
  }, []);

  // Live stream first, then the persisted timeline; items are upserted by id so the order of arrival doesn't matter.
  useEffect(() => {
    if (!convId) return;
    setItems([]);
    setUsage(null);
    const upsert = (it: TimelineItem) =>
      setItems((prev) => {
        const i = prev.findIndex((p) => p.id === it.id);
        if (i === -1) return [...prev, it].sort((a, b) => a.createdAt - b.createdAt);
        const next = prev.slice();
        next[i] = it;
        return next;
      });
    const es = new EventSource(`/api/stream/${convId}`);
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as PoppetEvent | { type: 'hello'; running: boolean };
      if (e.type === 'hello') setTurn(e.running ? 'running' : 'idle');
      else if (e.type === 'item') upsert(e.item);
      else if (e.type === 'delta')
        setItems((prev) => prev.map((p) => (p.id === e.itemId && p.kind === 'assistant' ? { ...p, text: p.text + e.text } : p)));
      else if (e.type === 'turn') {
        setTurn(e.state);
        if (e.state === 'idle') loadConvs();
      } else if (e.type === 'usage') setUsage(e);
    };
    api<{ items: TimelineItem[]; running: boolean; usage: Usage }>(`/api/conversations/${convId}`)
      .then((r) => {
        r.items.forEach(upsert);
        setTurn(r.running ? 'running' : 'idle');
        setUsage(r.usage);
      })
      .catch((e) => setError(e.message));
    return () => es.close();
  }, [convId, loadConvs]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [items.length, turn]);

  async function newConv() {
    const c = await post<Conv>('/api/conversations');
    await loadConvs();
    setConvId(c.id);
  }

  async function send() {
    const text = input.trim();
    if (!text) return;
    let id = convId;
    if (!id) {
      id = (await post<Conv>('/api/conversations')).id;
      setConvId(id);
      await loadConvs();
    }
    setError(null);
    try {
      await post('/api/chat', { convId: id, message: text, model: model || undefined });
      setInput('');
      setTurn('running');
      loadConvs();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const artifacts = items.filter((i) => i.kind === 'artifact');

  return (
    <div className="flex h-dvh">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50 md:flex dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center justify-between p-3">
          <span className="font-semibold">Poppet</span>
          <button
            data-testid="new-conversation"
            onClick={newConv}
            className="rounded-md border border-zinc-300 px-2 py-1 text-sm hover:bg-white dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            New
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto px-2">
          {convs.map((c) => (
            <button
              key={c.id}
              onClick={() => setConvId(c.id)}
              className={`mb-0.5 block w-full truncate rounded-md px-2 py-1.5 text-left text-sm ${c.id === convId ? 'bg-zinc-200 dark:bg-zinc-800' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/60'}`}
            >
              {c.running ? '● ' : ''}
              {c.title}
            </button>
          ))}
        </nav>
        <div className="border-t border-zinc-200 p-3 text-sm dark:border-zinc-800">
          <Link href="/settings" className="hover:underline">
            Settings
          </Link>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-zinc-200 px-4 py-2 text-sm dark:border-zinc-800">
          <button onClick={newConv} className="md:hidden">
            ＋
          </button>
          <span className="truncate font-medium">{convs.find((c) => c.id === convId)?.title ?? 'Poppet'}</span>
          <span className="ml-auto text-xs text-zinc-500" data-testid="usage">
            {usage ? `${(usage.inputTokens + usage.outputTokens).toLocaleString()} tokens · $${usage.costUsd.toFixed(4)}` : ''}
          </span>
          <button
            onClick={() => setShowArtifacts((v) => !v)}
            className="rounded border border-zinc-300 px-2 py-0.5 text-xs dark:border-zinc-700"
          >
            Artifacts{artifacts.length ? ` (${artifacts.length})` : ''}
          </button>
          <Link href="/settings" className="text-xs md:hidden">
            Settings
          </Link>
        </header>

        <div className="flex min-h-0 flex-1">
          <div className="flex-1 overflow-y-auto px-4 py-4" data-testid="timeline">
            <div className="mx-auto max-w-3xl">
              {items.length === 0 && (
                <p className="mt-16 text-center text-sm text-zinc-500">
                  Ask Poppet to triage your inbox, research something across sites, sign up for a service, or find leads.
                </p>
              )}
              <TimelineView items={items} />
              {turn !== 'idle' && (
                <div className="my-2 text-sm text-zinc-500" data-testid="turn-status">
                  {turn === 'retrying' ? 'Retrying…' : 'Working…'}
                  <button className="ml-3 underline" onClick={() => convId && post(`/api/conversations/${convId}/cancel`)}>
                    Stop
                  </button>
                </div>
              )}
              <div ref={bottom} />
            </div>
          </div>
          {showArtifacts && <ArtifactsPanel items={artifacts} />}
        </div>

        <footer className="border-t border-zinc-200 p-3 dark:border-zinc-800">
          {error && (
            <div className="mx-auto mb-2 max-w-3xl text-sm text-red-600" role="alert">
              {error}
            </div>
          )}
          <form
            className="mx-auto flex max-w-3xl items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <textarea
              data-testid="composer"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={2}
              placeholder="Message Poppet…"
              className="min-h-[2.75rem] flex-1 resize-none rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700"
            />
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="rounded-lg border border-zinc-300 bg-transparent px-2 py-2 text-xs dark:border-zinc-700"
              aria-label="Model"
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <button
              data-testid="send"
              type="submit"
              disabled={turn !== 'idle' || !input.trim()}
              className="rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
            >
              Send
            </button>
          </form>
        </footer>
      </main>
    </div>
  );
}
