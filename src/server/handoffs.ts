import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from './db';
import { handoffs } from './db/schema';
import type { Timeline } from './timeline';
import type { AuditLog } from './audit';

export type HandoffKind = 'captcha' | 'sms' | 'login' | 'other';

interface Waiter {
  resolve: (status: 'done' | 'cancelled') => void;
  itemId: string;
  convId: string;
}

/** Human handoffs for CAPTCHA / SMS / login walls (FR-4, FR-9, flow 13.3). */
export class HandoffManager {
  private waiters = new Map<string, Waiter>();
  /** Hook for bringing the browser window to the front. */
  onRaise?: (convId: string) => void;

  constructor(
    private db: Db,
    private timeline: Timeline,
    private audit: AuditLog,
  ) {}

  raise(
    convId: string,
    kind: HandoffKind,
    instructions: string,
    url?: string,
    signal?: AbortSignal,
  ): Promise<'done' | 'cancelled'> {
    const id = randomUUID();
    this.db
      .insert(handoffs)
      .values({ id, convId, kind, url: url ?? null, instructions, status: 'open', createdAt: Date.now() })
      .run();
    const item = this.timeline.add(convId, {
      kind: 'handoff',
      handoffId: id,
      handoffKind: kind,
      url,
      instructions,
      status: 'open',
    });
    this.audit.write(convId, 'handoff_raised', { handoffId: id, kind, url, instructions });
    this.onRaise?.(convId);
    return new Promise((resolve) => {
      this.waiters.set(id, { resolve, itemId: item.id, convId });
      signal?.addEventListener('abort', () => this.finish(id, 'cancelled'), { once: true });
    });
  }

  complete(id: string): boolean {
    return this.finish(id, 'done');
  }

  cancel(id: string): boolean {
    return this.finish(id, 'cancelled');
  }

  private finish(id: string, status: 'done' | 'cancelled'): boolean {
    const res = this.db
      .update(handoffs)
      .set({ status })
      .where(and(eq(handoffs.id, id), eq(handoffs.status, 'open')))
      .run();
    if (res.changes === 0) return false;
    const row = this.db.select().from(handoffs).where(eq(handoffs.id, id)).get()!;
    this.audit.write(row.convId, 'handoff_' + status, { handoffId: id });
    const w = this.waiters.get(id);
    this.waiters.delete(id);
    const itemId =
      w?.itemId ??
      this.timeline.list(row.convId).find((i) => i.kind === 'handoff' && i.handoffId === id)?.id;
    if (itemId) this.timeline.update(row.convId, itemId, { status } as never);
    w?.resolve(status);
    return true;
  }

  open(convId?: string) {
    const rows = this.db.select().from(handoffs).where(eq(handoffs.status, 'open')).all();
    return convId ? rows.filter((r) => r.convId === convId) : rows;
  }

  cancelOrphans(): void {
    for (const r of this.open()) if (!this.waiters.has(r.id)) this.finish(r.id, 'cancelled');
  }
}
