import { desc } from 'drizzle-orm';
import type { Db } from './db';
import { auditLog } from './db/schema';

export class AuditLog {
  constructor(private db: Db) {}

  write(convId: string | null, event: string, detail: unknown): void {
    this.db
      .insert(auditLog)
      .values({ convId, event, detailJson: JSON.stringify(detail ?? {}), createdAt: Date.now() })
      .run();
  }

  recent(limit = 200) {
    return this.db
      .select()
      .from(auditLog)
      .orderBy(desc(auditLog.id))
      .limit(limit)
      .all()
      .map((r) => ({ ...r, detail: JSON.parse(r.detailJson) }));
  }
}
