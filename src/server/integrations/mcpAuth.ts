import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { getConfig } from '../config';
import type { SecretStore } from '../secrets';
import type { McpConfig } from '../registry';

/** Stores an installed MCP server's OAuth client + tokens in the secret store. */
class SecretBackedProvider implements OAuthClientProvider {
  authorizationUrl?: URL;

  constructor(
    private name: string,
    private secrets: SecretStore,
  ) {}

  get redirectUrl() {
    return `${getConfig().appUrl}/api/oauth/mcp/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Poppet',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  state() {
    return this.name;
  }

  private async getJson<T>(k: string): Promise<T | undefined> {
    const v = await this.secrets.get(`mcp:${this.name}:${k}`);
    return v ? (JSON.parse(v) as T) : undefined;
  }

  clientInformation() {
    return this.getJson<OAuthClientInformationMixed>('client');
  }
  async saveClientInformation(info: OAuthClientInformationMixed) {
    await this.secrets.set(`mcp:${this.name}:client`, JSON.stringify(info));
  }
  tokens() {
    return this.getJson<OAuthTokens>('tokens');
  }
  async saveTokens(t: OAuthTokens) {
    await this.secrets.set(`mcp:${this.name}:tokens`, JSON.stringify(t));
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  async saveCodeVerifier(v: string) {
    await this.secrets.set(`mcp:${this.name}:verifier`, v);
  }
  async codeVerifier() {
    const v = await this.secrets.get(`mcp:${this.name}:verifier`);
    if (!v) throw new Error('No PKCE verifier saved');
    return v;
  }
}

export type McpConnection =
  | { ok: true; headers?: Record<string, string>; env?: Record<string, string> }
  | { ok: false; reason: 'needs_signin' | 'needs_secret'; missing?: string[] };

export class McpAuthService {
  constructor(private secrets: SecretStore) {}

  headerSecret(server: string, header: string) {
    return `mcp:${server}:header:${header}`;
  }
  envSecret(server: string, env: string) {
    return `mcp:${server}:env:${env}`;
  }

  /** Start OAuth for a remote server. Returns the URL the user must open, or undefined if already authorized. */
  async beginOAuth(cfg: McpConfig): Promise<string | undefined> {
    const p = new SecretBackedProvider(cfg.name, this.secrets);
    const r = await auth(p, { serverUrl: cfg.url! });
    return r === 'REDIRECT' ? p.authorizationUrl?.toString() : undefined;
  }

  async finishOAuth(cfg: McpConfig, code: string): Promise<void> {
    const p = new SecretBackedProvider(cfg.name, this.secrets);
    const r = await auth(p, { serverUrl: cfg.url!, authorizationCode: code });
    if (r !== 'AUTHORIZED') throw new Error('Authorization did not complete');
  }

  /** Resolve the credentials needed to connect; never exposed to the model. */
  async connection(cfg: McpConfig): Promise<McpConnection> {
    if (cfg.auth.type === 'oauth') {
      const p = new SecretBackedProvider(cfg.name, this.secrets);
      if (!(await p.tokens())) return { ok: false, reason: 'needs_signin' };
      try {
        const r = await auth(p, { serverUrl: cfg.url! });
        if (r !== 'AUTHORIZED') return { ok: false, reason: 'needs_signin' };
      } catch {
        return { ok: false, reason: 'needs_signin' };
      }
      const t = await p.tokens();
      return { ok: true, headers: { Authorization: `Bearer ${t!.access_token}` } };
    }
    const headers: Record<string, string> = {};
    const env: Record<string, string> = {};
    const missing: string[] = [];
    if (cfg.auth.type === 'headers')
      for (const h of cfg.auth.headers) {
        const v = await this.secrets.get(this.headerSecret(cfg.name, h.name));
        if (v === undefined) missing.push(h.name);
        else headers[h.name] = v;
      }
    for (const e of cfg.env ?? []) {
      const v = await this.secrets.get(this.envSecret(cfg.name, e));
      if (v === undefined) missing.push(e);
      else env[e] = v;
    }
    if (missing.length) return { ok: false, reason: 'needs_secret', missing };
    return { ok: true, headers, env };
  }
}
