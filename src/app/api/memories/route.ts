import { services } from '@/server/services';
import { guard, json } from '@/server/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return json({ memories: services().memory.list(500) });
}

export async function DELETE(req: Request) {
  const bad = guard(req);
  if (bad) return bad;
  const id = Number(new URL(req.url).searchParams.get('id'));
  if (!id) return json({ error: 'id required' }, 400);
  services().memory.delete(id);
  services().audit.write(null, 'memory_deleted', { id });
  return json({ ok: true });
}
