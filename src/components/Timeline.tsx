'use client';
import { useState } from 'react';
import type { TimelineItem } from '@/server/events';
import { post } from '@/lib/client';
import { Markdown } from './Markdown';

type Of<K extends TimelineItem['kind']> = Extract<TimelineItem, { kind: K }>;

export function TimelineView({ items }: { items: TimelineItem[] }) {
  return (
    <div className="space-y-2">
      {items.map((it) => (
        <Item key={it.id} it={it} />
      ))}
    </div>
  );
}

function Item({ it }: { it: TimelineItem }) {
  switch (it.kind) {
    case 'user':
      return (
        <div className="flex justify-end" data-testid="user-message">
          <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-zinc-100 px-3 py-2 text-sm dark:bg-zinc-800">
            {it.text}
          </div>
        </div>
      );
    case 'assistant':
      return it.text ? (
        <div data-testid="assistant-message" className="text-sm">
          <Markdown text={it.text} />
        </div>
      ) : null;
    case 'tool':
      return <ToolStep it={it} />;
    case 'approval':
      return <ApprovalCard it={it} />;
    case 'handoff':
      return <HandoffCard it={it} />;
    case 'signin':
      return <SigninCard it={it} />;
    case 'artifact':
      return (
        <div className="text-sm" data-testid="artifact-chip">
          📄{' '}
          <a href={it.url} target="_blank" rel="noopener noreferrer" className="underline">
            {it.name}
          </a>{' '}
          <span className="text-zinc-500">({it.artifactType === 'gdoc' ? 'Google Doc' : 'Markdown'})</span>
        </div>
      );
    case 'notice':
      return (
        <div className="text-xs text-zinc-500" data-testid="notice">
          {it.text}
        </div>
      );
    case 'error':
      return (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {it.text}
        </div>
      );
  }
}

const statusIcon = { running: '⏳', done: '✓', error: '⚠', denied: '⛔' } as const;

function ToolStep({ it }: { it: Of<'tool'> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-xs text-zinc-600 dark:text-zinc-400" data-testid="tool-step" data-tool={it.name} data-status={it.status}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 hover:text-zinc-900 dark:hover:text-zinc-100"
      >
        <span>{open ? '▾' : '▸'}</span>
        <span>{statusIcon[it.status]}</span>
        <span className="truncate">{it.label}</span>
      </button>
      {open && (
        <div className="ml-5 mt-1 space-y-1">
          <pre className="max-h-48 overflow-auto rounded bg-zinc-100 p-2 dark:bg-zinc-900">
            {JSON.stringify(it.input, null, 2)}
          </pre>
          {it.output && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-zinc-100 p-2 dark:bg-zinc-900">{it.output}</pre>
          )}
        </div>
      )}
    </div>
  );
}

function Badge({ status }: { status: string }) {
  const color =
    status === 'approved' || status === 'done' || status === 'connected'
      ? 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300'
      : status === 'pending' || status === 'open' || status === 'waiting'
        ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
        : 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300';
  return <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${color}`}>{status}</span>;
}

function ApprovalCard({ it }: { it: Of<'approval'> }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const decide = async (approved: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      await post(`/api/approvals/${it.approvalId}`, { approved, note: note || undefined });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="rounded-lg border border-amber-300 bg-amber-50/60 p-3 dark:border-amber-800 dark:bg-amber-950/30"
      data-testid="approval-card"
      data-approval-id={it.approvalId}
      data-status={it.status}
      data-tool={it.toolName}
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="text-sm font-semibold">{it.title}</span>
        <Badge status={it.status} />
      </div>
      <Markdown text={it.previewMd} className="text-sm" />
      <details className="mt-1 text-xs text-zinc-500">
        <summary>Parameters · {it.toolName}</summary>
        <pre className="mt-1 max-h-60 overflow-auto rounded bg-white/70 p-2 dark:bg-zinc-900">
          {JSON.stringify(it.input, null, 2)}
        </pre>
      </details>
      {it.status === 'pending' ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            data-testid="approve"
            disabled={busy}
            onClick={() => decide(true)}
            className="rounded-md bg-green-700 px-3 py-1 text-sm text-white disabled:opacity-50"
          >
            Approve
          </button>
          <input
            data-testid="reject-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional)"
            className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <button
            data-testid="reject"
            disabled={busy}
            onClick={() => decide(false)}
            className="rounded-md border border-zinc-400 px-3 py-1 text-sm disabled:opacity-50"
          >
            Reject
          </button>
        </div>
      ) : it.note ? (
        <div className="mt-1 text-xs text-zinc-500">Note: {it.note}</div>
      ) : null}
      {err && <div className="mt-1 text-xs text-red-600">{err}</div>}
    </div>
  );
}

function HandoffCard({ it }: { it: Of<'handoff'> }) {
  const [busy, setBusy] = useState(false);
  const act = async (action: 'continue' | 'cancel') => {
    setBusy(true);
    await post(`/api/handoffs/${it.handoffId}`, { action }).catch(() => {});
    setBusy(false);
  };
  return (
    <div
      className="rounded-lg border border-blue-300 bg-blue-50/60 p-3 dark:border-blue-800 dark:bg-blue-950/30"
      data-testid="handoff-card"
      data-status={it.status}
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="text-sm font-semibold">Your turn: {it.handoffKind === 'captcha' ? 'CAPTCHA' : it.handoffKind}</span>
        <Badge status={it.status} />
      </div>
      <p className="text-sm">{it.instructions}</p>
      {it.url && <p className="mt-1 truncate text-xs text-zinc-500">{it.url}</p>}
      {it.status === 'open' && (
        <div className="mt-2 flex gap-2">
          <button
            data-testid="handoff-continue"
            disabled={busy}
            onClick={() => act('continue')}
            className="rounded-md bg-blue-700 px-3 py-1 text-sm text-white disabled:opacity-50"
          >
            Continue
          </button>
          <button disabled={busy} onClick={() => act('cancel')} className="rounded-md border border-zinc-400 px-3 py-1 text-sm">
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

function SigninCard({ it }: { it: Of<'signin'> }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setErr(null);
    try {
      await post(`/api/integrations/${encodeURIComponent(it.server)}/credentials`, { values });
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div
      className="rounded-lg border border-violet-300 bg-violet-50/60 p-3 dark:border-violet-800 dark:bg-violet-950/30"
      data-testid="signin-card"
      data-status={it.status}
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="text-sm font-semibold">Connect {it.server}</span>
        <Badge status={it.status} />
      </div>
      {it.status === 'waiting' &&
        (it.url ? (
          <a
            href={`/api/integrations/${encodeURIComponent(it.server)}/signin`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block rounded-md bg-violet-700 px-3 py-1 text-sm text-white"
            data-testid="signin-link"
          >
            Sign in to {it.server}
          </a>
        ) : (
          <div className="space-y-1">
            {(it.fields ?? []).map((f) => (
              <label key={f} className="block text-xs">
                {f}
                <input
                  type="password"
                  data-testid={`signin-field-${f}`}
                  className="mt-0.5 block w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                  onChange={(e) => setValues((v) => ({ ...v, [f]: e.target.value }))}
                />
              </label>
            ))}
            <button data-testid="signin-save" onClick={save} className="rounded-md bg-violet-700 px-3 py-1 text-sm text-white">
              Save and connect
            </button>
          </div>
        ))}
      {err && <div className="mt-1 text-xs text-red-600">{err}</div>}
    </div>
  );
}
