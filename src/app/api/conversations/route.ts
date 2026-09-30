import { services } from '@/server/services';
import { guard, json } from '@/server/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = services();
  return json({
    conversations: s.conversations.list().map((c) => ({ ...c, running: s.sessions.isRunning(c.id) })),
    usage: s.conversations.usage(),
  });
}

export async function POST(req: Request) {
  const bad = guard(req);
  if (bad) return bad;
  return json(services().conversations.create(), 201);
}
