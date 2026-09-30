import { services } from '@/server/services';
import { body, guard, json } from '@/server/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const bad = guard(req);
  if (bad) return bad;
  const { id } = await params;
  const { approved, note } = await body<{ approved?: boolean; note?: string }>(req);
  if (typeof approved !== 'boolean') return json({ error: 'approved (boolean) is required' }, 400);
  const ok = services().approvals.decide(id, approved, note?.trim() || undefined);
  return ok ? json({ ok: true }) : json({ error: 'approval is not pending' }, 409);
}
