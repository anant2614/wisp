import { services } from '@/server/services';
import { body, guard, json } from '@/server/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST { action: 'continue' | 'cancel' } — also served at /api/handoffs/:id/continue. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const bad = guard(req);
  if (bad) return bad;
  const { id } = await params;
  const { action } = await body<{ action?: string }>(req);
  const h = services().handoffs;
  const ok = action === 'cancel' ? h.cancel(id) : h.complete(id);
  return ok ? json({ ok: true }) : json({ error: 'handoff is not open' }, 409);
}
