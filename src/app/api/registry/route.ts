import { services } from '@/server/services';
import { body, guard, json } from '@/server/http';
import type { RegistryKind } from '@/server/registry';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const s = services();
  const u = new URL(req.url);
  const kind = u.searchParams.get('kind') as RegistryKind | null;
  const name = u.searchParams.get('name');
  if (kind && name) return json({ source: s.registry.source(kind, name) });
  const [skills, tools, mcp, history] = await Promise.all([
    s.registry.activeSkills(),
    s.registry.activeTools(),
    s.registry.activeMcp(),
    s.registry.history(30),
  ]);
  return json({
    items: s.registry.items(),
    active: {
      skills: skills.map((x) => x.name),
      tools: tools.map((x) => x.manifest.name),
      mcp: mcp.map((x) => x.name),
    },
    grants: Object.fromEntries(tools.map((t) => [t.manifest.name, s.registry.grantedSecrets(t.manifest.name)])),
    history,
  });
}

/** POST { action: 'enable' | 'disable' | 'delete' | 'rollback', kind, name } */
export async function POST(req: Request) {
  const bad = guard(req);
  if (bad) return bad;
  const { action, kind, name } = await body<{ action?: string; kind?: RegistryKind; name?: string }>(req);
  if (!kind || !name || !['skill', 'tool', 'mcp'].includes(kind)) return json({ error: 'kind and name required' }, 400);
  const s = services();
  try {
    if (action === 'enable') await s.registry.setEnabled(kind, name, true);
    else if (action === 'disable') await s.registry.setEnabled(kind, name, false);
    else if (action === 'delete') await s.registry.remove(kind, name);
    else if (action === 'rollback') await s.registry.rollback(kind, name);
    else return json({ error: 'unknown action' }, 400);
    s.audit.write(null, 'registry_' + action, { kind, name, by: 'user' });
    return json({ ok: true });
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}
