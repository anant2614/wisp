import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getConfig } from './config';
import type { BrowserProbe } from './gate';

/**
 * Owns the Playwright MCP server (a real Chrome with a persistent profile).
 * The agent connects to it over HTTP; Poppet's own policy code connects as a
 * second client to the same shared browser context, so the gate can classify
 * clicks against a fresh snapshot and detect CAPTCHAs after each action.
 */
export class BrowserService implements BrowserProbe {
  private proc?: ChildProcess;
  private client?: Client;
  private starting?: Promise<void>;
  readonly port: number;

  constructor(
    private profileDir: string,
    private outputDir: string,
  ) {
    this.port = getConfig().browser.port;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  async ensureStarted(): Promise<void> {
    if (this.client) return;
    if (!this.starting)
      this.starting = this.start().catch((e) => {
        this.starting = undefined;
        throw e;
      });
    return this.starting;
  }

  private async start() {
    const c = getConfig().browser;
    fs.mkdirSync(this.profileDir, { recursive: true });
    fs.mkdirSync(this.outputDir, { recursive: true });
    if (!(await portOpen(this.port))) {
      const cli = playwrightMcpCli();
      const args = [
        cli,
        '--port',
        String(this.port),
        '--host',
        '127.0.0.1',
        '--allowed-hosts',
        '*',
        '--shared-browser-context',
        '--user-data-dir',
        this.profileDir,
        '--output-dir',
        this.outputDir,
      ];
      if (c.headless) args.push('--headless');
      if (c.executablePath) args.push('--executable-path', c.executablePath);
      if (c.allowFileUrls) args.push('--allow-unrestricted-file-access');
      if (process.getuid?.() === 0) args.push('--no-sandbox');
      this.proc = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: this.outputDir });
      this.proc.stderr?.on('data', () => {});
      this.proc.stdout?.on('data', () => {});
      this.proc.on('exit', () => {
        this.proc = undefined;
        this.client = undefined;
        this.starting = undefined;
      });
      for (let i = 0; i < 100 && !(await portOpen(this.port)); i++) await new Promise((r) => setTimeout(r, 100));
    }
    const client = new Client({ name: 'poppet-policy', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(this.url)));
    this.client = client;
  }

  private async call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    await this.ensureStarted();
    const r = (await this.client!.callTool({ name, arguments: args })) as { content?: { type: string; text?: string }[] };
    return (r.content ?? []).map((c) => c.text ?? '').join('\n');
  }

  /** Pass-through for engines that reach the browser via Poppet's MCP gateway. */
  async listTools(): Promise<{ name: string; description?: string; inputSchema: unknown }[]> {
    await this.ensureStarted();
    return (await this.client!.listTools()).tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureStarted();
    return this.client!.callTool({ name, arguments: args });
  }

  snapshot(): Promise<string> {
    return this.call('browser_snapshot');
  }

  async currentUrl(): Promise<string | undefined> {
    const s = await this.snapshot();
    return s.match(/Page URL:\s*(\S+)/)?.[1];
  }

  /** Bring the agent's Chrome window to the front for a handoff (headed mode only). */
  async bringToFront(): Promise<void> {
    if (getConfig().browser.headless) return;
    await this.call('browser_run_code_unsafe', { code: 'async (page) => { await page.bringToFront(); }' }).catch(() => {});
  }

  async stop() {
    await this.client?.close().catch(() => {});
    this.client = undefined;
    this.proc?.kill();
    this.proc = undefined;
  }
}

/**
 * Locate @playwright/mcp's CLI on disk. (require.resolve is rewritten by the
 * Next.js bundler, so walk up from the working directory instead.)
 */
function playwrightMcpCli(): string {
  if (process.env.POPPET_PLAYWRIGHT_MCP_CLI) return process.env.POPPET_PLAYWRIGHT_MCP_CLI;
  let dir = process.cwd();
  for (;;) {
    const candidate = path.join(dir, 'node_modules', '@playwright', 'mcp', 'cli.js');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Cannot find @playwright/mcp; run npm install');
    dir = parent;
  }
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
}
