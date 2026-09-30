import fs from 'node:fs';
import path from 'node:path';
import { query, type HookCallback, type McpServerConfig, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { getConfig } from '../../config';
import type { Services } from '../../services';
import type { TimelineItem } from '../../events';
import { BROWSER_SERVER, DISALLOWED_BUILTINS, EXTERNAL_PREFIX } from '../../policy/policy';
import { SECRET_KEYS, type Provider } from '../../providers';
import { buildToolServer, toolDefsFor } from '../toolServer';
import type { ToolPipeline } from '../pipeline';
import type { AgentEngine, TurnPlan } from './types';

/**
 * Environment for the Claude Code process behind the Agent SDK. Host env vars
 * that would change its behaviour are dropped; credentials depend on the provider:
 * an API key, a Claude subscription token (`claude setup-token`), or — with no
 * token — the Claude Code login already on this machine.
 */
export async function claudeEnv(provider: Provider, secrets: Services['secrets']): Promise<Record<string, string>> {
  const c = getConfig();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith('CLAUDE_CODE') || k.startsWith('ANTHROPIC_') || k === 'CLAUDECODE') continue;
    env[k] = v;
  }
  if (c.anthropicBaseUrl) env.ANTHROPIC_BASE_URL = c.anthropicBaseUrl;
  if (provider === 'claude_subscription') {
    const token = await secrets.get(SECRET_KEYS.claudeOauthToken);
    if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  } else {
    const key = c.anthropicApiKey ?? (await secrets.get(SECRET_KEYS.anthropicApiKey));
    if (key) env.ANTHROPIC_API_KEY = key;
  }
  return env;
}

export class ClaudeEngine implements AgentEngine {
  readonly name = 'claude' as const;

  constructor(
    private s: Services,
    private pipeline: ToolPipeline,
  ) {}

  async runTurn(plan: TurnPlan): Promise<void> {
    const { s } = this;
    const convId = plan.run.convId;
    let options = await this.options(plan);
    try {
      await this.consume(convId, query({ prompt: plan.prompt, options }), plan);
    } catch (e) {
      if (!options.resume || plan.run.abort.signal.aborted) throw e;
      // The saved session could not be resumed (e.g. deleted): start fresh.
      s.audit.write(convId, 'resume_failed', { error: String(e) });
      s.conversations.touch(convId, { sdkSessionId: null });
      options = { ...options, resume: undefined };
      await this.consume(convId, query({ prompt: plan.prompt, options }), plan);
    }
  }

  private async options(plan: TurnPlan): Promise<Options> {
    const { s, pipeline } = this;
    const c = getConfig();
    const run = plan.run;
    const convId = run.convId;
    const cwd = path.join(c.home, 'agent');
    fs.mkdirSync(cwd, { recursive: true });

    const mcpServers: Record<string, McpServerConfig> = {
      poppet: buildToolServer(await toolDefsFor(s), { convId, services: s, signal: run.abort.signal }),
    };
    if (c.browser.enabled)
      try {
        await s.browser.ensureStarted();
        mcpServers[BROWSER_SERVER] = { type: 'http', url: s.browser.url, alwaysLoad: true };
      } catch (e) {
        s.timeline.add(convId, { kind: 'notice', text: `The browser could not start: ${(e as Error).message}` });
      }
    for (const { cfg, conn } of plan.integrations) {
      if (!conn.ok) continue;
      mcpServers[EXTERNAL_PREFIX + cfg.name] =
        cfg.transport === 'http'
          ? { type: 'http', url: cfg.url!, headers: conn.headers }
          : { type: 'stdio', command: 'npx', args: ['-y', cfg.package!], env: { ...conn.env, PATH: process.env.PATH ?? '' } };
    }

    const pre: HookCallback = async (input, toolUseID) => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      const d = await pipeline.before(
        run,
        toolUseID ?? input.tool_use_id,
        input.tool_name,
        (input.tool_input ?? {}) as Record<string, unknown>,
      );
      return d.behavior === 'deny'
        ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.message } }
        : {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'allow',
              permissionDecisionReason: d.reason,
              updatedInput: d.updatedInput,
            },
          };
    };
    const post: HookCallback = async (input, toolUseID) => {
      if (input.hook_event_name !== 'PostToolUse') return {};
      const r = await pipeline.after(run, toolUseID ?? input.tool_use_id, input.tool_name, input.tool_response);
      if (!r.redacted && r.context.length === 0) return {};
      return {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          ...(r.context.length ? { additionalContext: r.context.join('\n') } : {}),
          ...(r.redacted ? { updatedMCPToolOutput: (r.response as { content?: unknown })?.content ?? r.response } : {}),
        },
      };
    };
    const postFailure: HookCallback = async (input, toolUseID) => {
      if (input.hook_event_name !== 'PostToolUseFailure') return {};
      pipeline.failed(run, toolUseID ?? input.tool_use_id, (input as { error?: unknown }).error);
      return {};
    };

    return {
      model: plan.model || c.model,
      cwd,
      env: await claudeEnv(plan.provider, s.secrets),
      systemPrompt: plan.systemPrompt,
      tools: [],
      disallowedTools: DISALLOWED_BUILTINS,
      settingSources: [],
      mcpServers,
      includePartialMessages: true,
      abortController: run.abort,
      resume: plan.resumeId,
      permissionMode: 'default',
      canUseTool: async (toolName, input, opts) => {
        const d = await s.gate.decide(
          { convId, toolUseId: opts.toolUseID ?? `cut_${Date.now()}`, signal: opts.signal },
          toolName,
          input,
        );
        return d.behavior === 'allow'
          ? { behavior: 'allow', updatedInput: d.updatedInput }
          : { behavior: 'deny', message: d.message };
      },
      hooks: {
        PreToolUse: [{ hooks: [pre], timeout: Math.ceil(c.approvalTimeoutMs / 1000) + 120 }],
        PostToolUse: [{ hooks: [post], timeout: 24 * 3600 }],
        PostToolUseFailure: [{ hooks: [postFailure] }],
      },
    };
  }

  private async consume(convId: string, q: AsyncIterable<SDKMessage>, plan: TurnPlan) {
    const s = this.s;
    const run = plan.run;
    // A subscription covers usage; total_cost_usd is only an API-price estimate.
    const billed = plan.provider !== 'claude_subscription';
    let streamItem: { id: string; text: string } | undefined;
    const streamedMessages = new Set<string>();
    let sawOutput = false;
    let currentMessageId = '';
    for await (const m of q) {
      if (run.abort.signal.aborted) break;
      switch (m.type) {
        case 'system':
          if (m.subtype === 'init') s.conversations.touch(convId, { sdkSessionId: m.session_id, engine: 'claude' });
          else if (m.subtype === 'api_retry') s.bus.emit(convId, { type: 'turn', state: 'retrying' });
          break;
        case 'stream_event': {
          const ev = m.event as any;
          if (ev.type === 'message_start') currentMessageId = ev.message?.id ?? '';
          if (ev.type === 'content_block_start' && ev.content_block?.type === 'text') {
            s.bus.emit(convId, { type: 'turn', state: 'running' });
            const it = s.timeline.add(convId, { kind: 'assistant', text: '', streaming: true });
            streamItem = { id: it.id, text: '' };
            streamedMessages.add(currentMessageId);
          } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && streamItem) {
            streamItem.text += ev.delta.text;
            s.timeline.delta(convId, streamItem.id, ev.delta.text);
          } else if (ev.type === 'content_block_stop' && streamItem) {
            s.timeline.update(convId, streamItem.id, { text: streamItem.text, streaming: false } as Partial<TimelineItem>);
            sawOutput ||= streamItem.text.trim().length > 0;
            streamItem = undefined;
          }
          break;
        }
        case 'assistant': {
          if (streamedMessages.has(m.message.id)) break;
          for (const b of m.message.content as any[])
            if (b.type === 'text' && b.text.trim()) {
              s.timeline.add(convId, { kind: 'assistant', text: b.text });
              sawOutput = true;
            }
          break;
        }
        case 'result': {
          const u = m.usage as any;
          const input = (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0);
          s.conversations.addUsage(convId, input, u?.output_tokens ?? 0, billed ? (m.total_cost_usd ?? 0) : 0);
          s.bus.emit(convId, { type: 'usage', ...s.conversations.usage(convId) });
          if (m.subtype !== 'success' || m.is_error)
            s.timeline.add(convId, {
              kind: 'error',
              text: `The agent stopped: ${(m as any).result || m.subtype}. Send a message to resume.`,
            });
          else if (!sawOutput && m.result?.trim()) s.timeline.add(convId, { kind: 'assistant', text: m.result });
          break;
        }
      }
    }
    if (streamItem)
      s.timeline.update(convId, streamItem.id, { text: streamItem.text, streaming: false } as Partial<TimelineItem>);
  }
}
