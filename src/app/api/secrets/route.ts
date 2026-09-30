import { services } from '@/server/services';
import { USER_SECRET_PREFIX } from '@/server/proposals';
import { body, guard, json } from '@/server/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** User-managed secrets that agent-written tools may be granted. Values are never returned. */
export async function GET() {
  const names = (await services().secrets.list())
    .filter((n) => n.startsWith(USER_SECRET_PREFIX))
    .map((n) => n.slice(USER_SECRET_PREFIX.length));
  return json({ names });
}

export async function POST(req: Request) {
  const bad = guard(req);
  if (bad) return bad;
  const { name, value } = await body<{ name?: string; value?: string }>(req);
  if (!name || !/^[A-Za-z0-9_\-]{1,64}$/.test(name) || !value) return json({ error: 'name and value required' }, 400);
  await services().secrets.set(USER_SECRET_PREFIX + name, value);
  services().audit.write(null, 'secret_saved', { name });
  return json({ ok: true });
}

export async function DELETE(req: Request) {
  const bad = guard(req);
  if (bad) return bad;
  const name = new URL(req.url).searchParams.get('name');
  if (!name) return json({ error: 'name required' }, 400);
  await services().secrets.delete(USER_SECRET_PREFIX + name);
  services().audit.write(null, 'secret_deleted', { name });
  return json({ ok: true });
}
