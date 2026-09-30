/**
 * The deterministic approval policy (PRD §10). Every tool call the agent makes
 * is mapped to an action class and a decision by this table — never by the model.
 */

export type ActionClass =
  | 'read'
  | 'local_write'
  | 'consequential_web'
  | 'outbound'
  | 'self_modification'
  | 'code_execution'
  | 'forbidden';

export type PolicyDecision = 'allow' | 'ask' | 'deny' | 'classify';

export interface PolicyEntry {
  cls: ActionClass;
  decision: PolicyDecision;
}

/** Server keys used when registering MCP servers with the SDK. */
export const BUILTIN_SERVER = 'poppet';
export const BROWSER_SERVER = 'browser';
export const EXTERNAL_PREFIX = 'ext_';

const BUILTIN: Record<string, PolicyEntry> = {
  gmail_search: { cls: 'read', decision: 'allow' },
  gmail_read: { cls: 'read', decision: 'allow' },
  inbox_wait_for_email: { cls: 'read', decision: 'allow' },
  reddit_search: { cls: 'read', decision: 'allow' },
  memory_search: { cls: 'read', decision: 'allow' },
  registry_list: { cls: 'read', decision: 'allow' },
  registry_search_integrations: { cls: 'read', decision: 'allow' },
  skill_load: { cls: 'read', decision: 'allow' },
  request_handoff: { cls: 'read', decision: 'allow' },

  export_markdown: { cls: 'local_write', decision: 'allow' },
  memory_save: { cls: 'local_write', decision: 'allow' },
  gdocs_create: { cls: 'local_write', decision: 'allow' },
  gmail_draft: { cls: 'local_write', decision: 'allow' },
  leads_save: { cls: 'local_write', decision: 'allow' },
  site_password: { cls: 'local_write', decision: 'allow' },

  gmail_send: { cls: 'outbound', decision: 'ask' },
  gdocs_share: { cls: 'outbound', decision: 'ask' },

  registry_propose_skill: { cls: 'self_modification', decision: 'ask' },
  registry_propose_tool: { cls: 'self_modification', decision: 'ask' },
  registry_install_mcp: { cls: 'self_modification', decision: 'ask' },
  registry_disable: { cls: 'self_modification', decision: 'ask' },
  grant_secret: { cls: 'self_modification', decision: 'ask' },

  sandbox_test: { cls: 'code_execution', decision: 'allow' },
};

const BROWSER: Record<string, PolicyEntry> = {
  browser_navigate: { cls: 'read', decision: 'allow' },
  browser_navigate_back: { cls: 'read', decision: 'allow' },
  browser_snapshot: { cls: 'read', decision: 'allow' },
  browser_take_screenshot: { cls: 'read', decision: 'allow' },
  browser_wait_for: { cls: 'read', decision: 'allow' },
  browser_tabs: { cls: 'read', decision: 'allow' },
  browser_console_messages: { cls: 'read', decision: 'allow' },
  browser_network_requests: { cls: 'read', decision: 'allow' },
  browser_network_request: { cls: 'read', decision: 'allow' },
  browser_resize: { cls: 'read', decision: 'allow' },
  browser_hover: { cls: 'read', decision: 'allow' },
  browser_find: { cls: 'read', decision: 'allow' },
  browser_close: { cls: 'read', decision: 'allow' },
  browser_emulate_media: { cls: 'read', decision: 'allow' },
  browser_select_option: { cls: 'read', decision: 'allow' },

  browser_click: { cls: 'consequential_web', decision: 'classify' },
  browser_type: { cls: 'consequential_web', decision: 'classify' },
  browser_fill_form: { cls: 'consequential_web', decision: 'classify' },
  browser_press_key: { cls: 'consequential_web', decision: 'classify' },
  browser_drag: { cls: 'consequential_web', decision: 'ask' },
  browser_file_upload: { cls: 'consequential_web', decision: 'ask' },
  browser_drop: { cls: 'consequential_web', decision: 'ask' },
  browser_handle_dialog: { cls: 'consequential_web', decision: 'ask' },

  // Arbitrary page JavaScript would bypass click classification entirely.
  browser_evaluate: { cls: 'forbidden', decision: 'deny' },
  browser_run_code_unsafe: { cls: 'forbidden', decision: 'deny' },
};

const READ_VERBS = /^(get|list|search|read|query|fetch|retrieve|find|lookup|describe|view|show)[_-]/i;

export interface ParsedToolName {
  server?: string;
  tool: string;
}

export function parseToolName(full: string): ParsedToolName {
  const m = full.match(/^mcp__(.+?)__(.+)$/);
  return m ? { server: m[1], tool: m[2] } : { tool: full };
}

export function policyFor(fullName: string): PolicyEntry {
  const { server, tool } = parseToolName(fullName);
  if (server === BUILTIN_SERVER) {
    if (tool.startsWith('sandbox_tool_')) return { cls: 'code_execution', decision: 'allow' };
    return BUILTIN[tool] ?? { cls: 'forbidden', decision: 'deny' };
  }
  if (server === BROWSER_SERVER) return BROWSER[tool] ?? { cls: 'consequential_web', decision: 'ask' };
  if (server?.startsWith(EXTERNAL_PREFIX)) {
    // Installed integrations: reads are allowed, everything else asks.
    return READ_VERBS.test(tool) ? { cls: 'read', decision: 'allow' } : { cls: 'outbound', decision: 'ask' };
  }
  // Claude Code built-ins (Bash, Write, WebFetch, ...) and anything unknown.
  return { cls: 'forbidden', decision: 'deny' };
}

/** Claude Code built-in tools Poppet never exposes (shell, file system outside workspace, etc.). */
export const DISALLOWED_BUILTINS = [
  'Bash',
  'BashOutput',
  'KillShell',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
  `mcp__${BROWSER_SERVER}__browser_evaluate`,
  `mcp__${BROWSER_SERVER}__browser_run_code_unsafe`,
];
