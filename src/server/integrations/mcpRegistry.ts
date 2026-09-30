import { getConfig } from '../config';

/** Normalised view of an entry in the official MCP registry. */
export interface IntegrationCandidate {
  name: string;
  title?: string;
  description: string;
  version?: string;
  repository?: string;
  /** Remote (HTTP) endpoints. */
  remotes: { type: string; url: string; headers?: { name: string; description?: string; isSecret?: boolean }[] }[];
  /** npm packages runnable with npx. */
  packages: { registryType: string; identifier: string; version?: string; env?: { name: string; description?: string; isSecret?: boolean }[] }[];
}

export async function searchIntegrations(query: string, limit = 10): Promise<IntegrationCandidate[]> {
  const base = getConfig().mcpRegistryUrl.replace(/\/$/, '');
  const res = await fetch(`${base}/v0/servers?search=${encodeURIComponent(query)}&limit=${limit}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`MCP registry ${res.status}`);
  const j = (await res.json()) as { servers?: any[] };
  return (j.servers ?? []).map((entry) => {
    const s = entry.server ?? entry;
    return {
      name: s.name,
      title: s.title,
      description: s.description ?? '',
      version: s.version,
      repository: s.repository?.url,
      remotes: (s.remotes ?? []).map((r: any) => ({
        type: r.type ?? r.transport_type,
        url: r.url,
        headers: r.headers,
      })),
      packages: (s.packages ?? [])
        .filter((p: any) => (p.registryType ?? p.registry_type ?? p.registry_name) === 'npm')
        .map((p: any) => ({
          registryType: 'npm',
          identifier: p.identifier ?? p.name,
          version: p.version,
          env: p.environmentVariables ?? p.environment_variables,
        })),
    } satisfies IntegrationCandidate;
  });
}

/** Look up one registry entry by exact name; installs must reference a registry-listed server. */
export async function findIntegration(name: string): Promise<IntegrationCandidate | undefined> {
  const short = name.split('/').pop() ?? name;
  const results = await searchIntegrations(short, 50);
  return results.find((r) => r.name === name);
}
