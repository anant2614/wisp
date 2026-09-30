import fs from 'node:fs';
import path from 'node:path';
import { Codex, type ThreadEvent, type ThreadOptions } from '@openai/codex-sdk';
import { getConfig } from '../../config';
import type { Services } from '../../services';
import type { TimelineItem } from '../../events';
import { codexBinary, SECRET_KEYS } from '../../providers';
import type { McpGateway } from '../mcpGateway';
import type { AgentEngine, TurnPlan } from './types';

/**
 * Codex features Poppet switches off: shell / exec, code mode, sub-agents,
 * apps, plugins, image tools, computer & browser use, etc. The agent only acts
 * through Poppet's gated MCP gateway. What remains (apply_patch) is blocked by
 * the read-only sandbox with approvals set to "never".
 */
const DISABLED_FEATURES = [
  'shell_tool',
  'unified_exec',
  'shell_snapshot',
  'code_mode_host',
  'multi_agent',
  'goals',
  'view_image',
  'image_generation',
  'apps',
  'plugins',
  'remote_plugin',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'in_app_browser',
  'tool_suggest',
  'skill_search',
  'skill_mcp_dependency_install',
  'sleep_tool',
  'worktrees',
  'hooks',
  'realtime_conversation',
  'tool_call_mcp_elicitation',
  'auth_elicitation',
];

export class CodexEngine implements AgentEngine {
  readonly name = 'codex' as const;

  constructor(
    private s: Services,
    private gateway: McpGateway,
  ) {}

  async codexClient(plan: TurnPlan, gateway: { url: string; token: string }): Promise<Codex> {
    const c = getConfig();
    const home = this.s.providers.codexHome();
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? home,
      CODEX_HOME: home,
      POPPET_MCP_TOKEN: gateway.token,
    };
    for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'TMPDIR', 'LANG'])
      if (process.env[k]) env[k] = process.env[k]!;

    const config: Record<string, any> = {
      developer_instructions: plan.systemPrompt,
      features: Object.fromEntries(DISABLED_FEATURES.map((f) => [f, false])),
      mcp_servers: {
        poppet: {
          url: gateway.url,
          bearer_token_env_var: 'POPPET_MCP_TOKEN',
          // Poppet's own gate decides; Codex must not add a second prompt it cannot show.
          default_tools_approval_mode: 'approve',
          startup_timeout_sec: 60,
          tool_timeout_sec: Math.ceil(c.approvalTimeoutMs / 1000) + 300,
        },
      },
    };
    let apiKey: string | undefined;
    if (plan.provider === 'openai_api') {
      apiKey = process.env.OPENAI_API_KEY || (await this.s.secrets.get(SECRET_KEYS.openaiApiKey));
      if (!apiKey) throw new Error('No OpenAI API key is configured (Settings → Model provider).');
      if (process.env.POPPET_OPENAI_BASE_URL) {
        // A custom Responses endpoint (used by the test fixtures).
        env.POPPET_OPENAI_KEY = apiKey;
        config.model_provider = 'poppet_openai';
        config.model_providers = {
          poppet_openai: {
            name: 'OpenAI (custom endpoint)',
            base_url: process.env.POPPET_OPENAI_BASE_URL,
            wire_api: 'responses',
            env_key: 'POPPET_OPENAI_KEY',
            supports_websockets: false,
          },
        };
        apiKey = undefined;
      }
    } else if (!this.s.providers.codexSignedIn()) {
      throw new Error('Sign in with ChatGPT first (Settings → Model provider).');
    }
    return new Codex({ codexPathOverride: codexBinary(), apiKey, env, config });
  }

  async runTurn(plan: TurnPlan): Promise<void> {
    const { s } = this;
    const convId = plan.run.convId;
    const gw = await this.gateway.open(plan);
    try {
      const codex = await this.codexClient(plan, gw);
      const cwd = path.join(getConfig().home, 'agent-codex');
      fs.mkdirSync(cwd, { recursive: true });
      const opts: ThreadOptions = {
        model: plan.model || process.env.POPPET_OPENAI_MODEL || undefined,
        workingDirectory: cwd,
        skipGitRepoCheck: true,
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        networkAccessEnabled: false,
        webSearchMode: 'disabled',
      };
      const thread = plan.resumeId ? codex.resumeThread(plan.resumeId, opts) : codex.startThread(opts);
      const { events } = await thread.runStreamed(plan.prompt, { signal: plan.run.abort.signal });
      await this.consume(convId, events, plan);
    } finally {
      await this.gateway.close(gw.token);
    }
  }

  private async consume(convId: string, events: AsyncGenerator<ThreadEvent>, plan: TurnPlan) {
    const s = this.s;
    const messages = new Map<string, { itemId: string; text: string }>();
    const subscription = plan.provider === 'openai_subscription';
    for await (const e of events) {
      if (plan.run.abort.signal.aborted) break;
      switch (e.type) {
        case 'thread.started':
          s.conversations.touch(convId, { sdkSessionId: e.thread_id, engine: 'codex' });
          break;
        case 'item.started':
        case 'item.updated':
        case 'item.completed': {
          const it = e.item;
          if (it.type === 'agent_message') {
            const done = e.type === 'item.completed';
            let m = messages.get(it.id);
            if (!m) {
              const created = s.timeline.add(convId, { kind: 'assistant', text: '', streaming: !done });
              m = { itemId: created.id, text: '' };
              messages.set(it.id, m);
            }
            if (it.text.startsWith(m.text) && it.text.length > m.text.length)
              s.timeline.delta(convId, m.itemId, it.text.slice(m.text.length));
            m.text = it.text;
            if (done) s.timeline.update(convId, m.itemId, { text: it.text, streaming: false } as Partial<TimelineItem>);
          } else if (it.type === 'command_execution' && e.type === 'item.completed') {
            // Shell is disabled; if Codex still runs something, it happened in its read-only sandbox. Record it.
            s.audit.write(convId, 'codex_command', { command: it.command, exitCode: it.exit_code });
            s.timeline.add(convId, {
              kind: 'tool',
              toolUseId: it.id,
              name: 'codex_shell',
              label: `Codex sandbox command: ${it.command}`,
              input: { command: it.command },
              status: it.status === 'completed' ? 'done' : 'error',
              output: it.aggregated_output.slice(0, 4000),
            });
          } else if (it.type === 'file_change' && e.type === 'item.completed') {
            s.audit.write(convId, 'codex_file_change', { changes: it.changes, status: it.status });
          } else if (
            it.type === 'error' &&
            e.type === 'item.completed' &&
            !/configuration setting|WebSockets|Code Mode is unavailable/i.test(it.message)
          ) {
            s.timeline.add(convId, { kind: 'notice', text: it.message });
          }
          break;
        }
        case 'turn.completed': {
          const u = e.usage;
          s.conversations.addUsage(convId, u.input_tokens + (u.cached_input_tokens ?? 0), u.output_tokens, 0);
          s.bus.emit(convId, { type: 'usage', ...s.conversations.usage(convId) });
          if (subscription) s.audit.write(convId, 'usage_subscription', { provider: plan.provider, usage: u });
          break;
        }
        case 'turn.failed':
          s.timeline.add(convId, { kind: 'error', text: `The agent stopped: ${e.error.message}. Send a message to resume.` });
          break;
        case 'error':
          if (/Reconnecting/i.test(e.message)) s.bus.emit(convId, { type: 'turn', state: 'retrying' });
          else s.timeline.add(convId, { kind: 'error', text: e.message });
          break;
      }
    }
    for (const m of messages.values()) s.timeline.update(convId, m.itemId, { streaming: false } as Partial<TimelineItem>);
  }
}
