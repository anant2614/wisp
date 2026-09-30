import { services } from '@/server/services';
import { BusyError } from '@/server/agent/session';
import { body, guard, json } from '@/server/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const bad = guard(req);
  if (bad) return bad;
  const { convId, message, model } = await body<{ convId?: string; message?: string; model?: string }>(req);
  if (!convId || !message?.trim()) return json({ error: 'convId and message are required' }, 400);
  if (typeof model === 'string' && model.length > 100) return json({ error: 'bad model' }, 400);
  try {
    services().sessions.startTurn(convId, message.trim(), { model });
    return json({ ok: true }, 202);
  } catch (e) {
    if (e instanceof BusyError) return json({ error: e.message }, 409);
    return json({ error: (e as Error).message }, 400);
  }
}
