import { services } from '@/server/services';
import { guard, json } from '@/server/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const bad = guard(req);
  if (bad) return bad;
  services().sessions.cancel((await params).id);
  return json({ ok: true });
}
