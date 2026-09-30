import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getConfig } from '../config';
import type { Services } from '../services';
import { BROWSER_SERVER, BUILTIN_SERVER, DISALLOWED_BUILTINS, EXTERNAL_PREFIX } from '../policy/policy';
import { runToolDef, toolDefsFor } from './toolServer';
import type { ToolPipeline, TurnRun } from './pipeline';
import type { TurnPlan } from './engines/types';

/** Tool names as [A-Za-z0-9_] identifiers (e.g. sandbox_tool_word-count → sandbox_tool_word_count). */
export function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '_');
}

type CallResult = { content: { type: string; text?: string; [k: string]: unknown }[]; isError?: boolean };

interface GatewayTool {
  /** Name the model sees inside the gateway's namespace. */
  name: string;
  /** Canonical name the policy table and UI use (mcp__<server>__<tool>). */
  canonical: string;
  description: string;
  inputSchema: Record<string, unknown>;
  exec: (args: Record<string, unknown>) => Promise<CallResult>;
}

interface Session {
  run: TurnRun;
  tools: Map<string, GatewayTool>;
  close: () => Promise<void>;
}

/**
 * A local MCP server that exposes every Poppet tool — built-ins, the shared
 * browser, and installed integrations — to engines that can only reach tools
 * over MCP (Codex). Each call runs through the same ToolPipeline as the Claude
 * engine, so the approval gate, redaction and handoffs apply identically.
 * Each turn gets its own bearer token.
 */
export class McpGateway {
  private server?: http.Server;
  private port = 0;
  private sessions = new Map<string, Session>();

  constructor(
    private s: Services,
    private pipeline: ToolPipeline,
  ) {}

  private async ensureServer() {
    if (this.server) return;
    const srv = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    this.port = (srv.address() as AddressInfo).port;
    this.server = srv;
  }

  url() {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  /** Open a gateway session for one turn; returns its bearer token. */
  async open(plan: TurnPlan): Promise<{ url: string; token: string }> {
    await this.ensureServer();
    const run = plan.run;
    const tools = new Map<string, GatewayTool>();
    // Codex routes only identifier-safe tool names; the canonical name keeps the original.
    const add = (t: GatewayTool) => tools.set(safeName(t.name), { ...t, name: safeName(t.name) });
    const ctx = { convId: run.convId, services: this.s, signal: run.abort.signal };

    for (const def of await toolDefsFor(this.s))
      add({
        name: def.name,
        canonical: `mcp__${BUILTIN_SERVER}__${def.name}`,
        description: def.description,
        inputSchema: z.toJSONSchema(z.object(def.schema)) as Record<string, unknown>,
        exec: (args) => runToolDef(def, args, ctx) as Promise<CallResult>,
      });

    if (getConfig().browser.enabled) {
      try {
        await this.s.browser.ensureStarted();
        for (const t of await this.s.browser.listTools()) {
          const canonical = `mcp__${BROWSER_SERVER}__${t.name}`;
          if (DISALLOWED_BUILTINS.includes(canonical)) continue;
          add({
            name: t.name,
            canonical,
            description: t.description ?? '',
            inputSchema: t.inputSchema as Record<string, unknown>,
            exec: (args) => this.s.browser.callTool(t.name, args) as Promise<CallResult>,
          });
        }
      } catch (e) {
        this.s.timeline.add(run.convId, { kind: 'notice', text: `The browser could not start: ${(e as Error).message}` });
      }
    }

    const clients: Client[] = [];
    for (const { cfg, conn } of plan.integrations) {
      if (!conn.ok) continue;
      try {
        const client = new Client({ name: 'poppet-gateway', version: '1.0.0' });
        await client.connect(
          cfg.transport === 'http'
            ? new StreamableHTTPClientTransport(new URL(cfg.url!), { requestInit: { headers: conn.headers ?? {} } })
            : new StdioClientTransport({
                command: 'npx',
                args: ['-y', cfg.package!],
                env: { ...conn.env, PATH: process.env.PATH ?? '' },
              }),
        );
        clients.push(client);
        for (const t of (await client.listTools()).tools)
          add({
            name: `${EXTERNAL_PREFIX}${cfg.name}__${t.name}`,
            canonical: `mcp__${EXTERNAL_PREFIX}${cfg.name}__${t.name}`,
            description: `[${cfg.name}] ${t.description ?? ''}`,
            inputSchema: t.inputSchema as Record<string, unknown>,
            exec: (args) => client.callTool({ name: t.name, arguments: args }) as Promise<CallResult>,
          });
      } catch (e) {
        this.s.timeline.add(run.convId, { kind: 'notice', text: `Could not connect to ${cfg.name}: ${(e as Error).message}` });
      }
    }

    const token = randomBytes(24).toString('hex');
    this.sessions.set(token, {
      run,
      tools,
      close: async () => {
        await Promise.all(clients.map((c) => c.close().catch(() => {})));
      },
    });
    return { url: this.url(), token };
  }

  async close(token: string) {
    const sess = this.sessions.get(token);
    this.sessions.delete(token);
    await sess?.close();
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const sess = this.sessions.get(token);
    if (!sess || new URL(req.url ?? '/', 'http://x').pathname !== '/mcp') {
      res.writeHead(401).end();
      return;
    }
    const server = new Server({ name: 'poppet', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [...sess.tools.values()].map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as any,
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (r) => this.call(sess, r.params.name, r.params.arguments ?? {}));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    let raw = '';
    for await (const c of req) raw += c;
    await server.connect(transport);
    await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
  }

  private async call(sess: Session, name: string, args: Record<string, unknown>): Promise<any> {
    const tool = sess.tools.get(name);
    if (!tool) return { content: [{ type: 'text', text: `Unknown tool ${name}` }], isError: true };
    const id = `gw_${randomUUID()}`;
    const d = await this.pipeline.before(sess.run, id, tool.canonical, args);
    if (d.behavior === 'deny') return { content: [{ type: 'text', text: d.message }], isError: true };
    let raw: CallResult;
    try {
      raw = await tool.exec(d.updatedInput);
    } catch (e) {
      this.pipeline.failed(sess.run, id, (e as Error).message);
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
    const r = await this.pipeline.after(sess.run, id, tool.canonical, raw);
    const content = [...(r.response.content ?? [])];
    if (r.context.length) content.push({ type: 'text', text: `[Poppet] ${r.context.join('\n')}` });
    return { ...r.response, content };
  }

  async stop() {
    for (const t of [...this.sessions.keys()]) await this.close(t);
    await new Promise((r) => this.server?.close(r));
    this.server = undefined;
  }
}
