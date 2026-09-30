/**
 * Typed events pushed to the UI over SSE. The EventBus interface is the seam
 * for v2 (Redis pub/sub); v1 keeps subscribers in memory.
 */

export type TimelineItem =
  | { id: string; kind: 'user'; text: string; createdAt: number }
  | { id: string; kind: 'assistant'; text: string; streaming?: boolean; createdAt: number }
  | {
      id: string;
      kind: 'tool';
      toolUseId: string;
      name: string;
      label: string;
      input: unknown;
      status: 'running' | 'done' | 'error' | 'denied';
      output?: string;
      createdAt: number;
    }
  | {
      id: string;
      kind: 'approval';
      approvalId: string;
      toolName: string;
      title: string;
      input: unknown;
      previewMd: string;
      status: 'pending' | 'approved' | 'rejected' | 'expired';
      note?: string;
      createdAt: number;
    }
  | {
      id: string;
      kind: 'handoff';
      handoffId: string;
      handoffKind: 'captcha' | 'sms' | 'login' | 'other';
      url?: string;
      instructions: string;
      status: 'open' | 'done' | 'cancelled';
      createdAt: number;
    }
  | {
      id: string;
      kind: 'artifact';
      artifactType: 'markdown' | 'gdoc';
      name: string;
      url: string;
      createdAt: number;
    }
  | {
      id: string;
      kind: 'signin';
      server: string;
      /** OAuth URL to open, when the integration uses OAuth. */
      url?: string;
      /** Credential fields to paste in (headers / env vars), when it uses API keys. */
      fields?: string[];
      status: 'waiting' | 'connected';
      createdAt: number;
    }
  | { id: string; kind: 'error'; text: string; createdAt: number }
  | { id: string; kind: 'notice'; text: string; createdAt: number };

export type PoppetEvent =
  | { type: 'item'; item: TimelineItem }
  | { type: 'delta'; itemId: string; text: string }
  | { type: 'turn'; state: 'running' | 'idle' | 'retrying' }
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd: number };

export interface EventBus {
  emit(convId: string, event: PoppetEvent): void;
  subscribe(convId: string, fn: (event: PoppetEvent) => void): () => void;
}

export class InMemoryEventBus implements EventBus {
  private subs = new Map<string, Set<(e: PoppetEvent) => void>>();

  emit(convId: string, event: PoppetEvent): void {
    for (const fn of this.subs.get(convId) ?? []) {
      try {
        fn(event);
      } catch {
        // a broken subscriber must not break the agent
      }
    }
  }

  subscribe(convId: string, fn: (e: PoppetEvent) => void): () => void {
    let set = this.subs.get(convId);
    if (!set) this.subs.set(convId, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }
}
