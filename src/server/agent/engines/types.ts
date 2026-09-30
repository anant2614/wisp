import type { McpConfig } from '../../registry';
import type { McpConnection } from '../../integrations/mcpAuth';
import type { Provider } from '../../providers';
import type { TurnRun } from '../pipeline';

/** Everything an engine needs to run one agent turn. */
export interface TurnPlan {
  run: TurnRun;
  provider: Provider;
  prompt: string;
  model?: string;
  systemPrompt: string;
  /** Installed integrations with their resolved (connected) credentials. */
  integrations: { cfg: McpConfig; conn: McpConnection }[];
  /** The engine's saved session/thread id to resume, if it owns this conversation. */
  resumeId?: string;
}

/**
 * An agent loop implementation. v1 ships two: the Claude Agent SDK and the
 * OpenAI Codex SDK. Both route every Poppet tool through the same ToolPipeline.
 */
export interface AgentEngine {
  readonly name: 'claude' | 'codex';
  runTurn(plan: TurnPlan): Promise<void>;
}
