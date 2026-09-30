import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from './db';
import { approvals } from './db/schema';
import type { Timeline } from './timeline';
import type { AuditLog } from './audit';

export interface ApprovalRequest {
  convId: string;
  toolName: string;
  title: string;
  input: unknown;
  previewMd: string;
}

export interface ApprovalDecision {
  approved: boolean;
  status: 'approved' | 'rejected' | 'expired';
  note?: string;
}

interface Waiter {
  resolve: (d: ApprovalDecision) => void;
  itemId: string;
  convId: string;
  timer: NodeJS.Timeout;
}

/**
 * Approval cards (FR-3, flow 13.2). request() inserts a row, shows a card, and
 * blocks until decide() is called or the approval expires.
 */
export class ApprovalManager {
  private waiters = new Map<string, Waiter>();
  /**
   * Called when a pending approval from a turn that no longer exists (server
   * restarted mid-turn) is decided. The session manager resumes the task.
   */
  onOrphanDecision?: (row: typeof approvals.$inferSelect, decision: ApprovalDecision) => void;

  constructor(
    private db: Db,
    private timeline: Timeline,
    private audit: AuditLog,
    private timeoutMs: number,
  ) {}

  request(req: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision> {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .insert(approvals)
      .values({
        id,
        convId: req.convId,
        toolName: req.toolName,
        inputJson: JSON.stringify(req.input ?? {}),
        previewMd: req.previewMd,
        status: 'pending',
        createdAt: now,
      })
      .run();
    const item = this.timeline.add(req.convId, {
      kind: 'approval',
      approvalId: id,
      toolName: req.toolName,
      title: req.title,
      input: req.input,
      previewMd: req.previewMd,
      status: 'pending',
    });
    this.audit.write(req.convId, 'approval_requested', { approvalId: id, toolName: req.toolName, input: req.input });
    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => this.finish(id, 'expired'), this.timeoutMs);
      this.waiters.set(id, { resolve, itemId: item.id, convId: req.convId, timer });
      signal?.addEventListener('abort', () => this.finish(id, 'expired', 'Turn was cancelled'), { once: true });
    });
  }

  /** Called by POST /api/approvals/:id. Returns false if not pending. */
  decide(id: string, approved: boolean, note?: string): boolean {
    const row = this.db.select().from(approvals).where(eq(approvals.id, id)).get();
    if (!row || row.status !== 'pending') return false;
    this.finish(id, approved ? 'approved' : 'rejected', note);
    return true;
  }

  private finish(id: string, status: ApprovalDecision['status'], note?: string) {
    const res = this.db
      .update(approvals)
      .set({ status, note: note ?? null, decidedAt: Date.now() })
      .where(and(eq(approvals.id, id), eq(approvals.status, 'pending')))
      .run();
    const w = this.waiters.get(id);
    this.waiters.delete(id);
    if (res.changes === 0) return;
    const row = this.db.select().from(approvals).where(eq(approvals.id, id)).get()!;
    this.audit.write(row.convId, 'approval_decided', { approvalId: id, toolName: row.toolName, status, note });
    if (w) {
      clearTimeout(w.timer);
      this.timeline.update(w.convId, w.itemId, { status, note } as never);
      w.resolve({ approved: status === 'approved', status, note });
    } else {
      // No live waiter (e.g. after a server restart): just update the card.
      const item = this.findItem(row.convId, id);
      if (item) this.timeline.update(row.convId, item, { status, note } as never);
      if (status !== 'expired') this.onOrphanDecision?.(row, { approved: status === 'approved', status, note });
    }
  }

  private findItem(convId: string, approvalId: string): string | undefined {
    return this.timeline.list(convId).find((i) => i.kind === 'approval' && i.approvalId === approvalId)?.id;
  }

  pending(convId?: string) {
    const rows = this.db.select().from(approvals).where(eq(approvals.status, 'pending')).all();
    return convId ? rows.filter((r) => r.convId === convId) : rows;
  }

  /** After a restart, pending approvals stay pending but still expire on schedule. */
  restoreOrphans(): void {
    for (const r of this.pending()) {
      if (this.waiters.has(r.id)) continue;
      const left = r.createdAt + this.timeoutMs - Date.now();
      if (left <= 0) this.finish(r.id, 'expired');
      else setTimeout(() => this.finish(r.id, 'expired'), left).unref?.();
    }
  }
}
