'use client';
import { useState } from 'react';
import type { TimelineItem } from '@/server/events';
import { Markdown } from './Markdown';

type Artifact = Extract<TimelineItem, { kind: 'artifact' }>;

export function ArtifactsPanel({ items }: { items: TimelineItem[] }) {
  const artifacts = items as Artifact[];
  const [viewing, setViewing] = useState<{ name: string; text: string } | null>(null);

  async function view(a: Artifact) {
    const text = await fetch(a.url).then((r) => r.text());
    setViewing({ name: a.name, text });
  }

  return (
    <aside
      className="hidden w-80 shrink-0 overflow-y-auto border-l border-zinc-200 p-3 lg:block dark:border-zinc-800"
      data-testid="artifacts-panel"
    >
      <h2 className="mb-2 text-sm font-semibold">Artifacts</h2>
      {artifacts.length === 0 && <p className="text-xs text-zinc-500">Exports and Google Docs from this conversation appear here.</p>}
      <ul className="space-y-2">
        {artifacts.map((a) => (
          <li key={a.id} className="rounded-md border border-zinc-200 p-2 text-sm dark:border-zinc-800" data-testid="artifact">
            <div className="truncate font-medium">{a.name}</div>
            <div className="mt-1 flex gap-3 text-xs">
              {a.artifactType === 'markdown' ? (
                <>
                  <button className="underline" onClick={() => view(a)}>
                    View
                  </button>
                  <a className="underline" href={`${a.url}?download=1`}>
                    Download
                  </a>
                </>
              ) : (
                <a className="underline" href={a.url} target="_blank" rel="noopener noreferrer">
                  Open Google Doc
                </a>
              )}
            </div>
          </li>
        ))}
      </ul>
      {viewing && (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/40 p-4" onClick={() => setViewing(null)}>
          <div
            className="max-h-[85vh] w-full max-w-3xl overflow-y-auto rounded-lg bg-white p-4 dark:bg-zinc-900"
            onClick={(e) => e.stopPropagation()}
            data-testid="artifact-viewer"
          >
            <div className="mb-2 flex items-center">
              <span className="font-semibold">{viewing.name}</span>
              <button className="ml-auto text-sm underline" onClick={() => setViewing(null)}>
                Close
              </button>
            </div>
            <Markdown text={viewing.text} className="text-sm" />
          </div>
        </div>
      )}
    </aside>
  );
}
