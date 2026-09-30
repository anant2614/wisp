import { services } from '@/server/services';
import { body, guard, json } from '@/server/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Save pasted API credentials (headers / env vars) for an installed integration. */
export async function POST(req: Request, { params }: { params: Promise<{ name: string }> }) {
  const bad = guard(req);
  if (bad) return bad;
  const { name } = await params;
  const { values } = await body<{ values?: Record<string, string> }>(req);
  const s = services();
  const cfg = (await s.registry.activeMcp()).find((c) => c.name === name);
  if (!cfg) return json({ error: 'no such integration' }, 404);
  const headers = cfg.auth.type === 'headers' ? cfg.auth.headers.map((h) => h.name) : [];
  for (const [k, v] of Object.entries(values ?? {})) {
    if (!v) continue;
    if (headers.includes(k)) await s.secrets.set(s.mcpAuth.headerSecret(name, k), v);
    else if (cfg.env?.includes(k)) await s.secrets.set(s.mcpAuth.envSecret(name, k), v);
  }
  const conn = await s.mcpAuth.connection(cfg);
  if (!conn.ok) return json({ error: 'still missing: ' + (conn.missing ?? []).join(', ') }, 400);
  s.audit.write(null, 'integration_connected', { name });
  s.sessions.onIntegrationConnected(name);
  return json({ ok: true });
}
