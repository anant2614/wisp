import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { Db } from './db';
import { messages } from './db/schema';
import type { EventBus, TimelineItem } from './events';

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;
export type NewItem = DistributiveOmit<TimelineItem, 'id' | 'createdAt'> & { id?: string };

/** Persists chat timeline items and pushes them to live subscribers. */
export class Timeline {
  constructor(
    private db: Db,
    private bus: EventBus,
  ) {}

  add(convId: string, item: NewItem): TimelineItem {
    const full = { ...item, id: item.id ?? randomUUID(), createdAt: Date.now() } as TimelineItem;
    this.db
      .insert(messages)
      .values({
        id: full.id,
        convId,
        role: full.kind,
        contentJson: JSON.stringify(full),
        createdAt: full.createdAt,
      })
      .run();
    this.bus.emit(convId, { type: 'item', item: full });
    return full;
  }

  update(convId: string, id: string, patch: Partial<TimelineItem>): TimelineItem | undefined {
    const row = this.db.select().from(messages).where(eq(messages.id, id)).get();
    if (!row) return undefined;
    const full = { ...JSON.parse(row.contentJson), ...patch } as TimelineItem;
    this.db
      .update(messages)
      .set({ contentJson: JSON.stringify(full) })
      .where(eq(messages.id, id))
      .run();
    this.bus.emit(convId, { type: 'item', item: full });
    return full;
  }

  find(id: string): TimelineItem | undefined {
    const row = this.db.select().from(messages).where(eq(messages.id, id)).get();
    return row ? (JSON.parse(row.contentJson) as TimelineItem) : undefined;
  }

  list(convId: string): TimelineItem[] {
    return this.db
      .select()
      .from(messages)
      .where(eq(messages.convId, convId))
      .orderBy(asc(messages.createdAt))
      .all()
      .map((r) => JSON.parse(r.contentJson) as TimelineItem);
  }

  delta(convId: string, itemId: string, text: string): void {
    this.bus.emit(convId, { type: 'delta', itemId, text });
  }
}
