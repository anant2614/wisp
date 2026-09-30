import { services } from '@/server/services';
import { guard, json } from '@/server/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = services();
  const conversation = s.conversations.get(id);
  if (!conversation) return json({ error: 'not found' }, 404);
  return json({
    conversation,
    items: s.timeline.list(id),
    running: s.sessions.isRunning(id),
    usage: s.conversations.usage(id),
  });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const bad = guard(req);
  if (bad) return bad;
  const { id } = await params;
  const s = services();
  s.sessions.cancel(id);
  s.conversations.delete(id);
  return json({ ok: true });
}
