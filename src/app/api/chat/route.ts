import { services } from '@/server/services';
import { BusyError } from '@/server/agent/session';
import { body, guard, json } from '@/server/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MODELS = new Set(['claude-sonnet-5-5', 'claude-opus-5-5']);

export async function POST(req: Request) {
  const bad = guard(req);
  if (bad) return bad;
  const { convId, message, model } = await body<{ convId?: string; message?: string; model?: string }>(req);
  if (!convId || !message?.trim()) return json({ error: 'convId and message are required' }, 400);
  if (model && !MODELS.has(model)) return json({ error: 'unknown model' }, 400);
  try {
    services().sessions.startTurn(convId, message.trim(), { model });
    return json({ ok: true }, 202);
  } catch (e) {
    if (e instanceof BusyError) return json({ error: e.message }, 409);
    return json({ error: (e as Error).message }, 400);
  }
}
