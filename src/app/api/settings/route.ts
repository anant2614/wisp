import { services } from '@/server/services';
import { getConfig } from '@/server/config';
import { body, guard, json } from '@/server/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = services();
  const c = getConfig();
  const integrations = await Promise.all(
    (await s.registry.activeMcp()).map(async (cfg) => ({ ...cfg, connected: (await s.mcpAuth.connection(cfg)).ok })),
  );
  return json({
    google: await s.google.status(),
    googleConfigured: Boolean(c.google.clientId),
    reddit: { configured: s.reddit.configured() },
    sandbox: { driver: c.sandbox.driver, available: await s.sandbox.available() },
    model: c.model,
    integrations,
    usage: s.conversations.usage(),
  });
}

/** POST { action: 'disconnect_google', account } */
export async function POST(req: Request) {
  const bad = guard(req);
  if (bad) return bad;
  const { action, account } = await body<{ action?: string; account?: 'personal' | 'agent' }>(req);
  if (action === 'disconnect_google' && (account === 'personal' || account === 'agent')) {
    await services().google.disconnect(account);
    services().audit.write(null, 'account_disconnected', { provider: 'google', account });
    return json({ ok: true });
  }
  return json({ error: 'unknown action' }, 400);
}
