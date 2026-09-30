import { stableJson, genericPreview, type GateContext, type PreviewProvider, type ToolPreview } from './gate';
import { assertName, type McpConfig, type Registry, type RegistryItem, type ToolManifest } from './registry';
import type { Sandbox } from './sandbox';
import type { SecretStore } from './secrets';
import { findIntegration } from './integrations/mcpRegistry';

export const USER_SECRET_PREFIX = 'user:';

/**
 * Builds approval-card previews (diffs, test output, integration details) and,
 * for self-modification, stages the change in registry/pending/ so approval
 * activates exactly what the user reviewed.
 */
export class ProposalService implements PreviewProvider {
  private staged = new Map<string, string>();

  constructor(
    private registry: Registry,
    private sandbox: Sandbox,
    private secrets: SecretStore,
  ) {}

  private key(convId: string, tool: string, input: unknown) {
    return `${convId}|${tool}|${stableJson(input)}`;
  }

  async preview(tool: string, input: Record<string, any>, ctx: GateContext): Promise<ToolPreview | undefined> {
    switch (tool) {
      case 'registry_propose_skill': {
        const { item, diff } = await this.registry.proposeSkill(input.name, input.skill_md, input.files ?? {});
        this.staged.set(this.key(ctx.convId, 'registry_propose_skill', input), item.id);
        return {
          title: `Add skill "${item.name}" (v${item.version})?`,
          markdown: `The agent wants to save a reusable **skill**. Approving writes it to \`registry/skills/${item.name}/\` and commits it to git.\n\n\`\`\`diff\n${diff}\n\`\`\``,
        };
      }
      case 'registry_propose_tool': {
        try {
          assertName(input.name);
        } catch (e) {
          return { title: '', markdown: '', autoDeny: String((e as Error).message) };
        }
        if (input.input_schema?.type !== 'object')
          return { title: '', markdown: '', autoDeny: 'input_schema must be a JSON Schema with type "object".' };
        const test = await this.sandbox.test({ code: input.code, tests: input.tests });
        if (!test.passed)
          return {
            title: '',
            markdown: '',
            autoDeny: `The tool's tests failed in the sandbox, so it was not proposed. Fix it (use sandbox_test) and propose again.\n\n${test.output}`,
          };
        const manifest: ToolManifest = {
          name: input.name,
          description: input.description,
          inputSchema: input.input_schema,
          secrets: input.secrets ?? [],
        };
        const { item, diff } = await this.registry.proposeTool(manifest, input.code, input.tests, test);
        this.staged.set(this.key(ctx.convId, 'registry_propose_tool', input), item.id);
        return {
          title: `Add tool "sandbox_tool_${item.name}" (v${item.version})?`,
          markdown: [
            `The agent wrote a new **tool**: ${manifest.description}`,
            '',
            `- Runs only inside the Docker sandbox.`,
            `- Secrets requested: ${manifest.secrets?.length ? manifest.secrets.map((s) => `\`${s}\``).join(', ') + ' (each needs a separate grant)' : 'none'}`,
            '',
            `**Tests: PASSED** (${test.durationMs} ms)`,
            '```',
            test.output.trim().slice(-3000),
            '```',
            '',
            '```diff',
            diff,
            '```',
          ].join('\n'),
        };
      }
      case 'registry_install_mcp': {
        const cand = await findIntegration(input.registry_name).catch(() => undefined);
        if (!cand)
          return {
            title: '',
            markdown: '',
            autoDeny: `"${input.registry_name}" is not in the official MCP registry. Only registry-listed servers can be installed; use registry_search_integrations to find the exact name.`,
          };
        const name = (input.name ?? cand.name.split('/').pop() ?? 'integration').toLowerCase().replace(/[^a-z0-9-]/g, '-');
        const remote = cand.remotes.find((r) => /streamable-http|^http$/.test(r.type));
        const pkg = cand.packages[0];
        let cfg: McpConfig;
        if (remote) {
          const secretHeaders = (remote.headers ?? []).filter((h) => h.isSecret !== false);
          cfg = {
            name,
            registryName: cand.name,
            description: cand.description,
            transport: 'http',
            url: remote.url,
            auth: secretHeaders.length
              ? { type: 'headers', headers: secretHeaders.map((h) => ({ name: h.name, description: h.description })) }
              : (await requiresOAuth(remote.url))
                ? { type: 'oauth' }
                : { type: 'none' },
          };
        } else if (pkg) {
          cfg = {
            name,
            registryName: cand.name,
            description: cand.description,
            transport: 'stdio',
            package: pkg.version ? `${pkg.identifier}@${pkg.version}` : pkg.identifier,
            auth: { type: 'none' },
            env: (pkg.env ?? []).filter((e) => e.isSecret !== false).map((e) => e.name),
          };
        } else
          return {
            title: '',
            markdown: '',
            autoDeny: `${cand.name} has neither a remote HTTP endpoint nor an npm package, so it cannot be installed.`,
          };
        try {
          assertName(cfg.name);
        } catch (e) {
          return { title: '', markdown: '', autoDeny: String((e as Error).message) };
        }
        const { item } = await this.registry.proposeMcp(cfg);
        this.staged.set(this.key(ctx.convId, 'registry_install_mcp', input), item.id);
        const authText =
          cfg.auth.type === 'oauth'
            ? 'OAuth sign-in (you will get a link after approving)'
            : cfg.auth.type === 'headers'
              ? `API credentials you paste in: ${cfg.auth.headers.map((h) => `\`${h.name}\``).join(', ')}`
              : cfg.env?.length
                ? `Environment secrets you paste in: ${cfg.env.map((e) => `\`${e}\``).join(', ')}`
                : 'none';
        return {
          title: `Install integration "${cfg.name}"?`,
          markdown: [
            `**${cand.title ?? cand.name}** — ${cand.description}`,
            '',
            `- **Registry entry:** \`${cand.name}\`${cand.version ? ` v${cand.version}` : ''}`,
            `- **Source:** ${cand.repository ?? 'not listed'}`,
            `- **Runs as:** ${cfg.transport === 'http' ? `remote server ${cfg.url}` : `local process \`npx -y ${cfg.package}\``}`,
            `- **Sign-in / scopes:** ${authText}`,
            '',
            'It gets no other secrets. Reads from it are allowed automatically; every other action still needs your approval.',
          ].join('\n'),
        };
      }
      case 'grant_secret': {
        const tools = await this.registry.activeTools();
        const t = tools.find((x) => x.manifest.name === input.tool);
        if (!t) return { title: '', markdown: '', autoDeny: `No active tool named "${input.tool}".` };
        if (!t.manifest.secrets?.includes(input.secret_name))
          return {
            title: '',
            markdown: '',
            autoDeny: `Tool "${input.tool}" does not declare the secret "${input.secret_name}" in its manifest.`,
          };
        if ((await this.secrets.get(USER_SECRET_PREFIX + input.secret_name)) === undefined)
          return {
            title: '',
            markdown: '',
            autoDeny: `There is no stored secret named "${input.secret_name}". Ask the user to add it in Settings → Secrets first.`,
          };
        return {
          title: `Give "${input.tool}" access to secret "${input.secret_name}"?`,
          markdown: `The sandboxed tool **${input.tool}** will receive the secret \`${input.secret_name}\` as \`ctx.secrets.${input.secret_name.replace(/[^A-Za-z0-9_]/g, '_')}\` on every call. Its value is never shown to the agent.`,
        };
      }
      case 'gmail_send':
        return {
          title: `Send email to ${input.to}?`,
          markdown: `**To:** ${input.to}${input.cc ? `\n**Cc:** ${input.cc}` : ''}\n**Subject:** ${input.subject}\n\n---\n\n${input.body}`,
        };
      case 'gdocs_share':
        return {
          title: `Share doc with ${input.email}?`,
          markdown: `Give **${input.email}** \`${input.role}\` access to document \`${input.doc_id}\`.`,
        };
      case 'registry_disable':
        return { title: `Disable ${input.kind} "${input.name}"?`, markdown: genericPreview(input) };
      default:
        return undefined;
    }
  }

  async rejected(tool: string, input: Record<string, unknown>, ctx: GateContext): Promise<void> {
    const k = this.key(ctx.convId, tool, input);
    const id = this.staged.get(k);
    if (!id) return;
    this.staged.delete(k);
    await this.registry.reject(id);
  }

  /** Called by the tool handler after approval: activate what was reviewed. */
  async activate(tool: string, input: Record<string, unknown>, convId: string): Promise<RegistryItem> {
    const k = this.key(convId, tool, input);
    const id = this.staged.get(k);
    if (!id) throw new Error('Nothing staged for this proposal (was it approved?)');
    this.staged.delete(k);
    return this.registry.approve(id);
  }
}

/** A remote MCP server that answers an unauthenticated initialize with 401 uses OAuth. */
async function requiresOAuth(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'poppet-probe', version: '1' } },
      }),
      signal: AbortSignal.timeout(5000),
    });
    return r.status === 401;
  } catch {
    return false;
  }
}
