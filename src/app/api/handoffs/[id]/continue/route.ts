import { services } from '@/server/services';
import { guard, json } from '@/server/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const bad = guard(req);
  if (bad) return bad;
  const ok = services().handoffs.complete((await params).id);
  return ok ? json({ ok: true }) : json({ error: 'handoff is not open' }, 409);
}
