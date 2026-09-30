import { z } from 'zod';
import { defineTool, untrusted, type ToolDef } from './types';
import { ReconnectError, type GoogleAccount } from '../integrations/google';
import { RedditUnavailableError } from '../integrations/reddit';
import { searchIntegrations } from '../integrations/mcpRegistry';
import { generatePassword, placeholder } from '../secrets';
import { renderLeadReport } from '../stores';
import { getConfig } from '../config';

const account = z.enum(['personal', 'agent']).optional().describe('Which Gmail account (default: personal)');

function googleError(e: unknown, ctx: { convId: string; services: any }) {
  if (e instanceof ReconnectError) {
    ctx.services.timeline.add(ctx.convId, {
      kind: 'notice',
      text: `Reconnect your ${e.account} Google account in Settings → Accounts.`,
    });
    return { text: e.message, isError: true };
  }
  throw e;
}

export const builtinTools: ToolDef<any>[] = [
  // ---------------- Gmail ----------------
  defineTool({
    name: 'gmail_search',
    description:
      'Search Gmail with Gmail query syntax (e.g. "is:unread newer_than:1d", "from:shop.com order"). Returns message summaries.',
    schema: { query: z.string(), account, max: z.number().int().min(1).max(50).optional() },
    async handler({ query, account: a, max }, ctx) {
      try {
        const items = await ctx.services.google.search((a ?? 'personal') as GoogleAccount, query, max ?? 20);
        if (!items.length) return 'No messages matched.';
        return untrusted(
          'email-list',
          items
            .map(
              (m) =>
                `- id=${m.id} ${m.unread ? '[UNREAD] ' : ''}${m.date}\n  From: ${m.from}\n  Subject: ${m.subject}\n  Snippet: ${m.snippet}`,
            )
            .join('\n'),
        );
      } catch (e) {
        return googleError(e, ctx);
      }
    },
  }),
  defineTool({
    name: 'gmail_read',
    description: 'Read one Gmail message by id (body and links).',
    schema: { id: z.string(), account },
    async handler({ id, account: a }, ctx) {
      try {
        const m = await ctx.services.google.read((a ?? 'personal') as GoogleAccount, id);
        return untrusted(
          'email',
          `From: ${m.from}\nTo: ${m.to ?? ''}\nDate: ${m.date}\nSubject: ${m.subject}\n\n${m.body.slice(0, 20_000)}\n\nLinks:\n${m.links.join('\n')}`,
        );
      } catch (e) {
        return googleError(e, ctx);
      }
    },
  }),
  defineTool({
    name: 'gmail_draft',
    description: 'Create a draft email in the personal account (not sent).',
    schema: { to: z.string(), subject: z.string(), body: z.string(), cc: z.string().optional() },
    async handler(args, ctx) {
      try {
        const d = await ctx.services.google.draft('personal', args);
        return `Draft created (id ${d.id}).`;
      } catch (e) {
        return googleError(e, ctx);
      }
    },
  }),
  defineTool({
    name: 'gmail_send',
    description: 'Send an email from the personal account. Requires the user\'s approval.',
    schema: {
      to: z.string(),
      subject: z.string(),
      body: z.string(),
      cc: z.string().optional(),
      in_reply_to: z.string().optional(),
    },
    async handler({ in_reply_to, ...rest }, ctx) {
      try {
        const r = await ctx.services.google.send('personal', { ...rest, inReplyTo: in_reply_to });
        return `Sent (message id ${r.id}).`;
      } catch (e) {
        return googleError(e, ctx);
      }
    },
  }),
  defineTool({
    name: 'inbox_wait_for_email',
    description:
      "Wait for an email to arrive in the agent's own inbox (used for sign-up verification). Returns the message with extracted links.",
    schema: {
      from: z.string().optional().describe('Sender address or domain'),
      subject_regex: z.string().optional(),
      timeout_seconds: z.number().int().min(5).max(900).optional(),
    },
    async handler({ from, subject_regex, timeout_seconds }, ctx) {
      const started = Date.now();
      const deadline = started + (timeout_seconds ?? 180) * 1000;
      const re = subject_regex ? new RegExp(subject_regex, 'i') : undefined;
      const q = ['newer_than:1d', from ? `from:${from}` : ''].filter(Boolean).join(' ');
      try {
        while (Date.now() < deadline) {
          if (ctx.signal?.aborted) return { text: 'Cancelled.', isError: true };
          const found = (await ctx.services.google.search('agent', q, 10)).filter(
            (m) => m.internalDate >= started - 120_000 && (!re || re.test(m.subject)),
          );
          if (found.length) {
            const m = await ctx.services.google.read('agent', found[0].id);
            return untrusted(
              'email',
              `From: ${m.from}\nSubject: ${m.subject}\n\n${m.body.slice(0, 8000)}\n\nLinks:\n${m.links.join('\n')}`,
            );
          }
          await new Promise((r) => setTimeout(r, getConfig().inboxPollMs));
        }
        return { text: `No matching email arrived within ${timeout_seconds ?? 180}s.`, isError: true };
      } catch (e) {
        return googleError(e, ctx);
      }
    },
  }),
  defineTool({
    name: 'site_password',
    description:
      "Get the sign-up identity for a website: the agent inbox address and a password placeholder. A strong password is generated and stored in the Keychain as site:<domain>; type the placeholder exactly as returned (browser_type / browser_fill_form substitute it on that domain only). You never see the real password.",
    schema: { domain: z.string().describe('Bare domain, e.g. example.com') },
    async handler({ domain }, ctx) {
      const d = domain.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
      const name = `site:${d}`;
      if (!(await ctx.services.secrets.get(name))) await ctx.services.secrets.set(name, generatePassword());
      const email = await ctx.services.google.email('agent');
      return `email: ${email ?? '(agent inbox not connected)'}\npassword: ${placeholder(name)}`;
    },
  }),

  // ---------------- Google Docs ----------------
  defineTool({
    name: 'gdocs_create',
    description: 'Create a new Google Doc from Markdown. Returns the document URL.',
    schema: { title: z.string(), markdown: z.string() },
    async handler({ title, markdown }, ctx) {
      try {
        const d = await ctx.services.google.createDoc(title, markdown);
        ctx.services.timeline.add(ctx.convId, { kind: 'artifact', artifactType: 'gdoc', name: title, url: d.url });
        return `Created Google Doc "${title}": ${d.url} (id ${d.id})`;
      } catch (e) {
        return googleError(e, ctx);
      }
    },
  }),
  defineTool({
    name: 'gdocs_share',
    description: 'Share a Google Doc with someone. Requires approval.',
    schema: { doc_id: z.string(), email: z.string(), role: z.enum(['reader', 'commenter', 'writer']) },
    async handler({ doc_id, email, role }, ctx) {
      try {
        await ctx.services.google.shareDoc(doc_id, email, role);
        return `Shared with ${email} as ${role}.`;
      } catch (e) {
        return googleError(e, ctx);
      }
    },
  }),

  // ---------------- Reddit leads ----------------
  defineTool({
    name: 'reddit_search',
    description:
      'Search Reddit (official API, read-only) for posts matching a query, optionally within subreddits. Use intent-style queries such as "looking for X", "alternative to Y".',
    schema: {
      query: z.string(),
      subreddits: z.array(z.string()).optional(),
      time_range: z.enum(['hour', 'day', 'week', 'month', 'year', 'all']).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async handler({ query, subreddits, time_range, limit }, ctx) {
      try {
        const items = await ctx.services.reddit.search(query, { subreddits, timeRange: time_range, limit });
        if (!items.length) return 'No results.';
        return untrusted(
          'reddit',
          items
            .map(
              (i) =>
                `- url=${i.url}\n  r/${i.subreddit} u/${i.author} ${new Date(i.createdUtc * 1000).toISOString().slice(0, 10)} score=${i.score}\n  ${i.title ? 'Title: ' + i.title + '\n  ' : ''}${i.text.slice(0, 500).replace(/\n+/g, ' ')}`,
            )
            .join('\n'),
        );
      } catch (e) {
        if (e instanceof RedditUnavailableError) {
          const u = `https://www.reddit.com/search/?q=${encodeURIComponent(query)}&t=${time_range ?? 'month'}`;
          return {
            text: `The Reddit API is unavailable (${e.message}). Fall back to reading public search results in the browser without logging in: ${u}`,
            isError: true,
          };
        }
        throw e;
      }
    },
  }),
  defineTool({
    name: 'leads_save',
    description:
      'Save a scored lead run (deduplicated by URL) and get back a Markdown report sorted by score, ready for export_markdown / gdocs_create.',
    schema: {
      product: z.string(),
      queries: z.array(z.string()),
      summary: z.string().optional(),
      leads: z.array(
        z.object({
          source_url: z.string(),
          author: z.string().optional(),
          subreddit: z.string().optional(),
          posted_at: z.string().optional().describe('ISO date'),
          excerpt: z.string().optional(),
          intent: z.string().optional(),
          score: z.number().min(0).max(100),
          rationale: z.string().optional(),
        }),
      ),
    },
    async handler({ product, queries, leads, summary }, ctx) {
      const { runId, count } = ctx.services.leads.saveRun(
        ctx.convId,
        product,
        queries,
        leads.map((l: any) => ({
          sourceUrl: l.source_url,
          author: l.author,
          subreddit: l.subreddit,
          postedAt: l.posted_at ? Date.parse(l.posted_at) || undefined : undefined,
          excerpt: l.excerpt,
          intent: l.intent,
          score: l.score,
          rationale: l.rationale,
        })),
      );
      const md = renderLeadReport(product, ctx.services.leads.run(runId), summary);
      return `Saved ${count} leads (run ${runId}).\n\n${md}`;
    },
  }),

  // ---------------- Memory & export ----------------
  defineTool({
    name: 'memory_save',
    description: 'Save a long-term memory: a fact, a preference, or the outcome of a task.',
    schema: { text: z.string(), tags: z.array(z.string()).optional() },
    async handler({ text, tags }, ctx) {
      const m = ctx.services.memory.save(text, tags ?? [], ctx.convId);
      return `Saved memory #${m.id}.`;
    },
  }),
  defineTool({
    name: 'memory_search',
    description: 'Search long-term memories.',
    schema: { query: z.string(), k: z.number().int().min(1).max(20).optional() },
    async handler({ query, k }, ctx) {
      const r = ctx.services.memory.search(query, k ?? 5);
      return r.length ? r.map((m: any) => `- #${m.id}: ${m.text}`).join('\n') : 'No memories found.';
    },
  }),
  defineTool({
    name: 'export_markdown',
    description: 'Write a Markdown file to the exports folder and show it in the artifacts panel.',
    schema: { filename: z.string(), content: z.string() },
    async handler({ filename, content }, ctx) {
      const f = ctx.services.exports.write(filename, content);
      ctx.services.timeline.add(ctx.convId, {
        kind: 'artifact',
        artifactType: 'markdown',
        name: f.name,
        url: `/api/exports/${encodeURIComponent(f.name)}`,
      });
      return `Exported ${f.name}.`;
    },
  }),

  // ---------------- Handoff ----------------
  defineTool({
    name: 'request_handoff',
    description:
      'Ask the user to complete a step you must not do yourself (CAPTCHA, SMS/phone verification, logging in with their personal credentials) in the agent browser. Blocks until they click Continue.',
    schema: {
      kind: z.enum(['captcha', 'sms', 'login', 'other']),
      instructions: z.string(),
      url: z.string().optional(),
    },
    async handler({ kind, instructions, url }, ctx) {
      const status = await ctx.services.handoffs.raise(ctx.convId, kind, instructions, url, ctx.signal);
      return status === 'done'
        ? 'The user completed the step. Take a fresh browser_snapshot before continuing.'
        : { text: 'The user cancelled the handoff.', isError: true };
    },
  }),

  // ---------------- Registry / self-extension ----------------
  defineTool({
    name: 'registry_list',
    description: 'List installed skills, agent-written tools and integrations.',
    schema: {},
    async handler(_, ctx) {
      const r = ctx.services.registry;
      const [skills, tools, mcp] = await Promise.all([r.activeSkills(), r.activeTools(), r.activeMcp()]);
      return [
        `Skills: ${skills.map((s: any) => `${s.name} — ${s.description}`).join('; ') || 'none'}`,
        `Tools: ${tools.map((t: any) => `${t.manifest.name}${t.degraded ? ' (degraded)' : ''} — ${t.manifest.description}`).join('; ') || 'none'}`,
        `Integrations: ${mcp.map((m: any) => `${m.name} (${m.registryName})`).join('; ') || 'none'}`,
      ].join('\n');
    },
  }),
  defineTool({
    name: 'skill_load',
    description: 'Load an active skill\'s full instructions (SKILL.md) and bundled files.',
    schema: { name: z.string() },
    async handler({ name }, ctx) {
      const s = await ctx.services.registry.readSkill(name);
      if (!s) return { text: `No active skill "${name}".`, isError: true };
      return `${s.skillMd}\n\nFiles: ${s.files.join(', ')}`;
    },
  }),
  defineTool({
    name: 'registry_propose_skill',
    description:
      'Propose a reusable skill: a folder with SKILL.md (YAML frontmatter with name and description, then step-by-step instructions) and optional files. The user reviews a preview before it is activated.',
    schema: {
      name: z.string().describe('lowercase-with-dashes'),
      skill_md: z.string(),
      files: z.record(z.string(), z.string()).optional().describe('Extra files: relative path → content'),
    },
    async handler(args, ctx) {
      const item = await ctx.services.proposals.activate('registry_propose_skill', args, ctx.convId);
      return `Skill "${item.name}" v${item.version} is now active. It will be listed in your instructions from the next turn.`;
    },
  }),
  defineTool({
    name: 'sandbox_test',
    description:
      'Run a candidate tool\'s tests in the sandbox without proposing it. Use this to iterate (up to 3 revisions) before registry_propose_tool. Code: `export default async function run(input, ctx) {...}` in tool.ts; tests: node:test file importing "./tool.ts".',
    schema: { code: z.string(), tests: z.string() },
    async handler({ code, tests }, ctx) {
      const r = await ctx.services.sandbox.test({ code, tests });
      return { text: `${r.passed ? 'PASSED' : 'FAILED'} in ${r.durationMs}ms\n${r.output}`, isError: !r.passed };
    },
  }),
  defineTool({
    name: 'registry_propose_tool',
    description:
      'Propose a new tool written in TypeScript. Its tests run in the sandbox and the user reviews the code, test output and requested secrets. Once approved it is available as sandbox_tool_<name> and always runs in the sandbox with no credentials unless granted.',
    schema: {
      name: z.string(),
      description: z.string(),
      input_schema: z.record(z.string(), z.any()).describe('JSON Schema of type "object"'),
      code: z.string(),
      tests: z.string(),
      secrets: z.array(z.string()).optional().describe('Names of secrets the tool needs (granted separately)'),
    },
    async handler(args, ctx) {
      const item = await ctx.services.proposals.activate('registry_propose_tool', args, ctx.convId);
      ctx.services.sessions.requestContinuation(ctx.convId, `Tool sandbox_tool_${item.name} is now available.`);
      return `Tool "${item.name}" is approved. It becomes callable as sandbox_tool_${item.name} on the next turn — finish this turn now; Poppet will resume automatically.`;
    },
  }),
  defineTool({
    name: 'registry_search_integrations',
    description: 'Search the official MCP registry for an integration (MCP server) for a service, e.g. "notion".',
    schema: { query: z.string() },
    async handler({ query }, ctx) {
      const r = await searchIntegrations(query);
      if (!r.length) return 'No integrations found.';
      return r
        .map(
          (c) =>
            `- ${c.name}${c.version ? '@' + c.version : ''}: ${c.description}\n  remote: ${c.remotes.map((x) => x.url).join(', ') || 'none'}; npm: ${c.packages.map((p) => p.identifier).join(', ') || 'none'}${c.repository ? `; repo: ${c.repository}` : ''}`,
        )
        .join('\n');
    },
  }),
  defineTool({
    name: 'registry_install_mcp',
    description:
      'Install an integration from the official MCP registry (by its exact registry name). The user approves and then signs in if needed; the session restarts with the new tools.',
    schema: {
      registry_name: z.string(),
      name: z.string().optional().describe('Short local name (lowercase-with-dashes)'),
    },
    async handler(args, ctx) {
      const item = await ctx.services.proposals.activate('registry_install_mcp', args, ctx.convId);
      const res = await ctx.services.sessions.afterMcpInstall(ctx.convId, item.name);
      return res;
    },
  }),
  defineTool({
    name: 'registry_disable',
    description: 'Disable an installed skill, tool or integration.',
    schema: { kind: z.enum(['skill', 'tool', 'mcp']), name: z.string() },
    async handler({ kind, name }, ctx) {
      await ctx.services.registry.setEnabled(kind, name, false);
      return `Disabled ${kind} ${name}.`;
    },
  }),
  defineTool({
    name: 'grant_secret',
    description: 'Ask the user to let an agent-written tool use one of their stored secrets.',
    schema: { tool: z.string(), secret_name: z.string() },
    async handler({ tool, secret_name }, ctx) {
      ctx.services.registry.grantSecret(tool, secret_name);
      return `Granted ${secret_name} to ${tool}.`;
    },
  }),
];
