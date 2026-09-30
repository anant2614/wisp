import { describe, expect, it } from 'vitest';
import { parseToolName, policyFor } from '@/server/policy/policy';

describe('approval policy table (PRD §10)', () => {
  const cases: [string, string, string][] = [
    // Read → allow
    ['mcp__browser__browser_navigate', 'read', 'allow'],
    ['mcp__browser__browser_snapshot', 'read', 'allow'],
    ['mcp__poppet__gmail_search', 'read', 'allow'],
    ['mcp__poppet__gmail_read', 'read', 'allow'],
    ['mcp__poppet__reddit_search', 'read', 'allow'],
    ['mcp__poppet__memory_search', 'read', 'allow'],
    ['mcp__poppet__inbox_wait_for_email', 'read', 'allow'],
    // Local write → allow (logged)
    ['mcp__poppet__export_markdown', 'local_write', 'allow'],
    ['mcp__poppet__memory_save', 'local_write', 'allow'],
    ['mcp__poppet__gdocs_create', 'local_write', 'allow'],
    // Consequential web → classified against the page, or ask
    ['mcp__browser__browser_click', 'consequential_web', 'classify'],
    ['mcp__browser__browser_type', 'consequential_web', 'classify'],
    ['mcp__browser__browser_fill_form', 'consequential_web', 'classify'],
    ['mcp__browser__browser_file_upload', 'consequential_web', 'ask'],
    // Outbound communication → ask
    ['mcp__poppet__gmail_send', 'outbound', 'ask'],
    ['mcp__poppet__gdocs_share', 'outbound', 'ask'],
    // Self-modification → ask
    ['mcp__poppet__registry_propose_skill', 'self_modification', 'ask'],
    ['mcp__poppet__registry_propose_tool', 'self_modification', 'ask'],
    ['mcp__poppet__registry_install_mcp', 'self_modification', 'ask'],
    ['mcp__poppet__grant_secret', 'self_modification', 'ask'],
    // Code execution in the sandbox → allow
    ['mcp__poppet__sandbox_test', 'code_execution', 'allow'],
    ['mcp__poppet__sandbox_tool_word-count', 'code_execution', 'allow'],
    // Forbidden → deny
    ['Bash', 'forbidden', 'deny'],
    ['Write', 'forbidden', 'deny'],
    ['WebFetch', 'forbidden', 'deny'],
    ['mcp__browser__browser_evaluate', 'forbidden', 'deny'],
    ['mcp__browser__browser_run_code_unsafe', 'forbidden', 'deny'],
    ['mcp__poppet__reddit_post', 'forbidden', 'deny'],
    ['mcp__random__anything', 'forbidden', 'deny'],
  ];

  it.each(cases)('%s → %s / %s', (tool, cls, decision) => {
    expect(policyFor(tool)).toEqual({ cls, decision });
  });

  it('installed integrations: reads allowed, everything else asks', () => {
    expect(policyFor('mcp__ext_notion__search_pages').decision).toBe('allow');
    expect(policyFor('mcp__ext_notion__get-page').decision).toBe('allow');
    expect(policyFor('mcp__ext_notion__create_page').decision).toBe('ask');
    expect(policyFor('mcp__ext_notion__delete_page').decision).toBe('ask');
    expect(policyFor('mcp__ext_notion__searchandreplace').decision).toBe('ask');
  });

  it('unknown browser tools default to ask', () => {
    expect(policyFor('mcp__browser__browser_something_new').decision).toBe('ask');
  });

  it('parses MCP tool names', () => {
    expect(parseToolName('mcp__ext_notion__create_page')).toEqual({ server: 'ext_notion', tool: 'create_page' });
    expect(parseToolName('Bash')).toEqual({ tool: 'Bash' });
  });
});
