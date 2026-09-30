import type { Services } from '../services';
import { buildSystemPrompt } from './prompt';
import { parseToolName } from '../policy/policy';
import type { TimelineItem } from '../events';
import { engineFor, MODEL_OPTIONS } from '../providers';
import { ToolPipeline, type TurnRun } from './pipeline';
import { McpGateway } from './mcpGateway';
import { ClaudeEngine } from './engines/claude';
import { CodexEngine } from './engines/codex';
import type { AgentEngine } from './engines/types';

export { labelFor } from './labels';

export class BusyError extends Error {
  constructor() {
    super('A turn is already running in this conversation');
  }
}

/**
 * Runs agent turns on the engine for the selected model provider (Claude Agent
 * SDK or Codex), resuming that engine's saved session for the conversation.
 * Turns run on the server, independent of any browser tab (NFR reliability).
 */
export class SessionManager {
  private running = new Map<string, TurnRun>();
  private continuations = new Map<string, string[]>();
  private awaitingSignin = new Map<string, string>(); // server name → convId
  readonly pipeline: ToolPipeline;
  readonly gateway: McpGateway;
  private engines: Record<'claude' | 'codex', AgentEngine>;

  constructor(private s: Services) {
    this.pipeline = new ToolPipeline(s);
    this.gateway = new McpGateway(s, this.pipeline);
    this.engines = { claude: new ClaudeEngine(s, this.pipeline), codex: new CodexEngine(s, this.gateway) };
  }

  isRunning(convId: string) {
    return this.running.has(convId);
  }

  /** Start a turn. Returns immediately; progress arrives as events. */
  startTurn(convId: string, text: string, opts: { internal?: boolean; model?: string } = {}): void {
    if (this.running.has(convId)) throw new BusyError();
    const conv = this.s.conversations.get(convId);
    if (!conv) throw new Error('No such conversation');
    if (opts.internal) this.s.timeline.add(convId, { kind: 'notice', text: `Resuming: ${text}` });
    else {
      this.s.timeline.add(convId, { kind: 'user', text });
      if (conv.title === 'New conversation') this.s.conversations.touch(convId, { title: text.slice(0, 60) });
    }
    const run: TurnRun = { convId, abort: new AbortController(), toolItems: new Map() };
    this.running.set(convId, run);
    this.s.bus.emit(convId, { type: 'turn', state: 'running' });
    void this.runTurn(convId, text, run, opts.model)
      .catch((e) => {
        this.s.timeline.add(convId, { kind: 'error', text: `The turn failed: ${e?.message ?? e}. Send a message to resume.` });
        this.s.audit.write(convId, 'turn_error', { error: String(e?.stack ?? e) });
      })
      .finally(() => {
        this.running.delete(convId);
        this.s.conversations.touch(convId);
        this.s.bus.emit(convId, { type: 'turn', state: 'idle' });
        const next = this.continuations.get(convId);
        if (next?.length) {
          this.continuations.delete(convId);
          setTimeout(() => {
            try {
              this.startTurn(convId, next.join(' '), { internal: true });
            } catch {
              /* a user turn got there first */
            }
          }, 50);
        }
      });
  }

  cancel(convId: string) {
    this.running.get(convId)?.abort.abort();
  }

  /** Queue an automatic follow-up turn (e.g. after new tools become available). */
  requestContinuation(convId: string, reason: string) {
    const list = this.continuations.get(convId) ?? [];
    list.push(`${reason} Continue the user's task.`);
    this.continuations.set(convId, list);
  }

  /** After an integration is approved: prompt for sign-in, or restart right away. */
  async afterMcpInstall(convId: string, name: string): Promise<string> {
    const cfg = (await this.s.registry.activeMcp()).find((c) => c.name === name);
    if (!cfg) return `Integration ${name} could not be found after install.`;
    const conn = await this.s.mcpAuth.connection(cfg);
    if (conn.ok) {
      this.requestContinuation(convId, `The ${name} integration is installed and connected.`);
      return `Installed ${name}. Its tools become available on the next turn — end this turn now; Poppet will resume automatically.`;
    }
    this.awaitingSignin.set(name, convId);
    let url: string | undefined;
    if (cfg.auth.type === 'oauth') url = await this.s.mcpAuth.beginOAuth(cfg).catch(() => undefined);
    const fields = cfg.auth.type === 'headers' ? cfg.auth.headers.map((h) => h.name) : (cfg.env ?? []);
    this.s.timeline.add(convId, { kind: 'signin', server: name, url, fields: url ? undefined : fields, status: 'waiting' });
    return `Installed ${name}. The user must now sign in (a sign-in card is shown). End this turn and tell the user; Poppet resumes automatically once they are connected.`;
  }

  /** Called when the user finishes signing in to an integration. */
  onIntegrationConnected(name: string) {
    const convId = this.awaitingSignin.get(name);
    for (const c of this.s.conversations.list()) {
      for (const it of this.s.timeline.list(c.id))
        if (it.kind === 'signin' && it.server === name && it.status === 'waiting')
          this.s.timeline.update(c.id, it.id, { status: 'connected' } as Partial<TimelineItem>);
    }
    if (!convId) return;
    this.awaitingSignin.delete(name);
    const msg = `The ${name} integration is now connected.`;
    if (this.running.has(convId)) this.requestContinuation(convId, msg);
    else this.startTurn(convId, `${msg} Continue the user's task.`, { internal: true });
  }

  /** A pending approval from a turn lost in a restart was decided. */
  onOrphanApproval(convId: string, toolName: string, input: unknown, approved: boolean, note?: string) {
    if (approved) this.s.gate.grantCarryOver(convId, toolName, input);
    const tool = parseToolName(toolName).tool;
    const msg = approved
      ? `Poppet restarted while waiting for approval of ${tool}. The user has now approved it — repeat exactly the same ${tool} call (same arguments) and continue.`
      : `Poppet restarted while waiting for approval of ${tool}. The user rejected it${note ? ` with the note "${note}"` : ''}. Adapt accordingly.`;
    if (this.running.has(convId)) this.requestContinuation(convId, msg);
    else this.startTurn(convId, msg, { internal: true });
  }

  // ------------------------------------------------------------------

  private async runTurn(convId: string, userText: string, run: TurnRun, model?: string) {
    const s = this.s;
    const provider = s.providers.current();
    const engine = this.engines[engineFor(provider)];
    if (model && !MODEL_OPTIONS[engine.name].some((m) => m.id === model)) model = undefined;
    const conv = s.conversations.get(convId)!;
    // Sessions belong to one engine; rows from before engines existed are Claude sessions.
    const owner = conv.engine ?? (conv.sdkSessionId ? 'claude' : null);
    const resumeId = owner === engine.name ? (conv.sdkSessionId ?? undefined) : undefined;
    let prompt = userText;
    if (!resumeId && owner && owner !== engine.name) {
      // Switched providers mid-conversation: carry the conversation over as context.
      s.conversations.touch(convId, { sdkSessionId: null, engine: null });
      prompt = this.transcript(convId, userText);
    }

    const integrations = await Promise.all(
      (await s.registry.activeMcp()).map(async (cfg) => ({ cfg, conn: await s.mcpAuth.connection(cfg) })),
    );
    const [skills, tools, status] = await Promise.all([s.registry.activeSkills(), s.registry.activeTools(), s.google.status()]);
    const systemPrompt = buildSystemPrompt({
      memories: s.memory.search(userText, 5),
      skills,
      integrations: integrations.map((i) => ({ cfg: i.cfg, connected: i.conn.ok })),
      sandboxTools: tools.map((t) => ({ name: t.manifest.name, description: t.manifest.description, degraded: t.degraded })),
      accounts: { personal: status.personal.email, agent: status.agent.email },
      now: new Date(),
    });
    s.audit.write(convId, 'turn_started', { provider, engine: engine.name, model: model ?? null, resumed: Boolean(resumeId) });
    await engine.runTurn({ run, provider, prompt, model, systemPrompt, integrations, resumeId });
  }

  private transcript(convId: string, current: string): string {
    const lines: string[] = [];
    for (const it of this.s.timeline.list(convId)) {
      if (it.kind === 'user') lines.push(`User: ${it.text}`);
      else if (it.kind === 'assistant' && it.text) lines.push(`Assistant: ${it.text}`);
    }
    if (lines.length && lines[lines.length - 1] === `User: ${current}`) lines.pop();
    const history = lines.join('\n\n').slice(-12_000);
    return history
      ? `(The conversation so far, from a previous model session:)\n\n${history}\n\n(Now the user says:)\n\n${current}`
      : current;
  }
}
