import { EXTERNAL_PREFIX, parseToolName } from '../policy/policy';

function safeHost(u: string) {
  try {
    return new URL(u).host || u;
  } catch {
    return u;
  }
}

/** Human-readable label for a tool step in the chat (FR-2). */
export function labelFor(toolName: string, input: Record<string, unknown>): string {
  const { server, tool } = parseToolName(toolName);
  const host = (u: unknown) => (typeof u === 'string' ? safeHost(u) : '');
  const el = String(input.element ?? input.target ?? '');
  switch (tool) {
    case 'browser_navigate':
      return `Browsing ${host(input.url)}`;
    case 'browser_snapshot':
      return 'Reading the page';
    case 'browser_click':
      return `Clicking ${el}`;
    case 'browser_type':
      return `Typing into ${el}`;
    case 'browser_fill_form':
      return 'Filling in a form';
    case 'gmail_search':
      return `Searching Gmail${input.account === 'agent' ? ' (agent inbox)' : ''}: ${String(input.query ?? '')}`;
    case 'gmail_read':
      return 'Reading an email';
    case 'gmail_send':
      return `Sending email to ${String(input.to ?? '')}`;
    case 'gmail_draft':
      return `Drafting email to ${String(input.to ?? '')}`;
    case 'inbox_wait_for_email':
      return 'Waiting for an email in the agent inbox';
    case 'reddit_search':
      return `Searching Reddit: ${String(input.query ?? '')}`;
    case 'gdocs_create':
      return `Creating Google Doc “${String(input.title ?? '')}”`;
    case 'export_markdown':
      return `Exporting ${String(input.filename ?? '')}`;
    case 'memory_search':
      return 'Searching memory';
    case 'memory_save':
      return 'Saving a memory';
    case 'registry_propose_skill':
      return `Proposing skill ${String(input.name ?? '')}`;
    case 'registry_propose_tool':
      return `Proposing tool ${String(input.name ?? '')}`;
    case 'registry_install_mcp':
      return `Installing integration ${String(input.registry_name ?? '')}`;
    case 'leads_save':
      return `Scoring and saving ${Array.isArray(input.leads) ? input.leads.length : ''} leads`;
    case 'site_password':
      return `Preparing sign-up details for ${String(input.domain ?? '')}`;
    case 'skill_load':
      return `Loading skill ${String(input.name ?? '')}`;
    case 'request_handoff':
      return 'Handing a step over to you';
    case 'sandbox_test':
      return 'Testing code in the sandbox';
    case 'gdocs_share':
      return `Sharing a doc with ${String(input.email ?? '')}`;
    case 'grant_secret':
      return `Granting ${String(input.secret_name ?? '')} to ${String(input.tool ?? '')}`;
    case 'registry_list':
      return 'Listing installed abilities';
    case 'registry_search_integrations':
      return `Searching integrations: ${String(input.query ?? '')}`;
    default:
      return server && server.startsWith(EXTERNAL_PREFIX) ? `${server.slice(EXTERNAL_PREFIX.length)}: ${tool}` : tool;
  }
}
