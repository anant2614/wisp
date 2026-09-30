import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { getConfig } from './config';
import type { SecretStore } from './secrets';
import type { SettingsStore } from './stores';

/**
 * Which model account powers the agent.
 *
 * - anthropic_api:       Claude via an Anthropic API key (Claude Agent SDK).
 * - claude_subscription: Claude via the user's Claude Pro/Max plan — either the
 *                        local Claude Code login or a `claude setup-token` token.
 * - openai_subscription: OpenAI models via the user's ChatGPT plan, through the
 *                        Codex CLI's "Sign in with ChatGPT".
 * - openai_api:          OpenAI models via an OpenAI API key (through Codex).
 *
 * Subscriptions are for the author's personal use of their own account only.
 */
export type Provider = 'anthropic_api' | 'claude_subscription' | 'openai_subscription' | 'openai_api';
export const PROVIDERS: Provider[] = ['anthropic_api', 'claude_subscription', 'openai_subscription', 'openai_api'];
export type Engine = 'claude' | 'codex';

export function engineFor(p: Provider): Engine {
  return p === 'openai_subscription' || p === 'openai_api' ? 'codex' : 'claude';
}

export const SECRET_KEYS = {
  anthropicApiKey: 'provider:anthropic_api_key',
  claudeOauthToken: 'provider:claude_oauth_token',
  openaiApiKey: 'provider:openai_api_key',
} as const;

export const MODEL_OPTIONS: Record<Engine, { id: string; label: string }[]> = {
  claude: [
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
    { id: 'claude-opus-5-5', label: 'Opus 5.5 (hard tasks)' },
  ],
  // Empty id = the account's default Codex model; POPPET_OPENAI_MODEL can pin one.
  codex: [{ id: '', label: 'Codex default model' }],
};

export interface ProviderStatus {
  provider: Provider;
  ready: boolean;
  detail: string;
}

const LOGIN_URL = /https:\/\/auth\.openai\.com\/\S+/;

export class ProviderService {
  private login?: { proc: ChildProcess; url?: string; done: boolean; error?: string };

  constructor(
    private settings: SettingsStore,
    private secrets: SecretStore,
  ) {}

  current(): Provider {
    const saved = this.settings.get('provider') as Provider | undefined;
    if (saved && PROVIDERS.includes(saved)) return saved;
    const env = process.env.POPPET_PROVIDER as Provider | undefined;
    if (env && PROVIDERS.includes(env)) return env;
    return getConfig().anthropicApiKey ? 'anthropic_api' : 'claude_subscription';
  }

  select(p: Provider) {
    if (!PROVIDERS.includes(p)) throw new Error(`Unknown provider ${p}`);
    this.settings.set('provider', p);
  }

  /** Poppet keeps its own Codex home so the user's ~/.codex config, skills and MCP servers never leak in. */
  codexHome(): string {
    const dir = path.join(getConfig().home, 'codex');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private userCodexAuth(): string {
    return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
  }

  codexSignedIn(): boolean {
    return fs.existsSync(path.join(this.codexHome(), 'auth.json'));
  }

  async status(): Promise<ProviderStatus[]> {
    const c = getConfig();
    const anthropicKey = c.anthropicApiKey || (await this.secrets.get(SECRET_KEYS.anthropicApiKey));
    const claudeToken = await this.secrets.get(SECRET_KEYS.claudeOauthToken);
    const openaiKey = process.env.OPENAI_API_KEY || (await this.secrets.get(SECRET_KEYS.openaiApiKey));
    return [
      {
        provider: 'anthropic_api',
        ready: Boolean(anthropicKey),
        detail: anthropicKey ? 'API key configured' : 'Add an Anthropic API key',
      },
      {
        provider: 'claude_subscription',
        ready: true,
        detail: claudeToken
          ? 'Using your saved Claude subscription token'
          : 'Using the Claude Code login on this machine (run `claude login`), or paste a `claude setup-token` token',
      },
      {
        provider: 'openai_subscription',
        ready: this.codexSignedIn(),
        detail: this.codexSignedIn()
          ? 'Signed in with ChatGPT'
          : fs.existsSync(this.userCodexAuth())
            ? 'Not signed in — you can import your existing Codex login'
            : 'Not signed in — use "Sign in with ChatGPT"',
      },
      {
        provider: 'openai_api',
        ready: Boolean(openaiKey),
        detail: openaiKey ? 'API key configured' : 'Add an OpenAI API key',
      },
    ];
  }

  canImportCodexLogin(): boolean {
    return !this.codexSignedIn() && fs.existsSync(this.userCodexAuth());
  }

  /** Copy an existing `codex login` (ChatGPT) from ~/.codex into Poppet's Codex home. */
  importCodexLogin() {
    const src = this.userCodexAuth();
    if (!fs.existsSync(src)) throw new Error('No existing Codex login found in ~/.codex');
    fs.copyFileSync(src, path.join(this.codexHome(), 'auth.json'));
    fs.chmodSync(path.join(this.codexHome(), 'auth.json'), 0o600);
  }

  /**
   * Start "Sign in with ChatGPT": runs `codex login` with Poppet's Codex home.
   * Codex serves its own OAuth callback on localhost:1455 and writes auth.json.
   */
  async startChatGptLogin(): Promise<string> {
    if (this.login && !this.login.done && this.login.url) return this.login.url;
    this.login?.proc.kill();
    const proc = spawn(/*turbopackIgnore: true*/ codexBinary(), ['login'], {
      env: { ...process.env, CODEX_HOME: this.codexHome(), BROWSER: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const state: { proc: ChildProcess; url?: string; done: boolean; error?: string } = { proc, done: false };
    this.login = state;
    let out = '';
    const onData = (d: Buffer) => {
      out += d.toString();
      state.url ??= out.match(LOGIN_URL)?.[0];
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.on('exit', (code) => {
      state.done = true;
      if (code !== 0 && !this.codexSignedIn()) state.error = out.trim().split('\n').pop();
    });
    for (let i = 0; i < 100 && !state.url && !state.done; i++) await new Promise((r) => setTimeout(r, 100));
    if (!state.url) throw new Error(`Could not start ChatGPT sign-in: ${out.trim().slice(0, 300)}`);
    return state.url;
  }

  loginState() {
    return { inProgress: Boolean(this.login && !this.login.done), error: this.login?.error, signedIn: this.codexSignedIn() };
  }

  signOutChatGpt() {
    this.login?.proc.kill();
    fs.rmSync(path.join(this.codexHome(), 'auth.json'), { force: true });
  }
}

/**
 * Locate the platform Codex binary shipped with @openai/codex (the SDK's own
 * resolution uses require.resolve, which bundlers can rewrite).
 */
export function codexBinary(): string {
  if (process.env.POPPET_CODEX_PATH) return process.env.POPPET_CODEX_PATH;
  const triples: Record<string, string> = {
    'linux-x64': 'x86_64-unknown-linux-musl',
    'linux-arm64': 'aarch64-unknown-linux-musl',
    'darwin-x64': 'x86_64-apple-darwin',
    'darwin-arm64': 'aarch64-apple-darwin',
    'win32-x64': 'x86_64-pc-windows-msvc',
    'win32-arm64': 'aarch64-pc-windows-msvc',
  };
  const key = `${process.platform}-${process.arch}`;
  const exe = process.platform === 'win32' ? 'codex.exe' : 'codex';
  let dir = process.cwd();
  for (;;) {
    const scope = path.join(dir, 'node_modules', '@openai');
    for (const pkg of [`codex-${key}`, 'codex']) {
      const candidate = path.join(scope, pkg, 'vendor', triples[key] ?? '', 'bin', exe);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Cannot find the Codex CLI; run npm install');
    dir = parent;
  }
}
