import path from 'node:path';

/**
 * All runtime configuration comes from environment variables so that every
 * external dependency (Google, Reddit, MCP registry, model API) can be pointed
 * at a fixture server in tests, and swapped for hosted versions in v2.
 */
export interface PoppetConfig {
  home: string;
  appUrl: string;
  model: string;
  anthropicBaseUrl?: string;
  anthropicApiKey?: string;
  google: {
    clientId?: string;
    clientSecret?: string;
    authUrl: string;
    tokenUrl: string;
    gmailBase: string;
    driveBase: string;
    driveUploadBase: string;
  };
  reddit: {
    clientId?: string;
    clientSecret?: string;
    userAgent: string;
    authUrl: string;
    apiBase: string;
  };
  mcpRegistryUrl: string;
  browser: {
    enabled: boolean;
    headless: boolean;
    executablePath?: string;
    port: number;
    allowFileUrls: boolean;
  };
  sandbox: {
    driver: 'docker' | 'disabled';
    image: string;
    timeoutMs: number;
  };
  secretsDriver: 'keychain' | 'file' | 'memory';
  approvalTimeoutMs: number;
  inboxPollMs: number;
}

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export function getConfig(): PoppetConfig {
  const e = process.env;
  const home = path.resolve(/*turbopackIgnore: true*/ e.POPPET_HOME || path.join(process.cwd(), 'workspace'));
  return {
    home,
    appUrl: e.POPPET_APP_URL || 'http://localhost:3000',
    model: e.POPPET_MODEL || 'claude-sonnet-5-5',
    anthropicBaseUrl: e.POPPET_ANTHROPIC_BASE_URL || undefined,
    anthropicApiKey: e.POPPET_ANTHROPIC_API_KEY || e.ANTHROPIC_API_KEY || undefined,
    google: {
      clientId: e.GOOGLE_CLIENT_ID,
      clientSecret: e.GOOGLE_CLIENT_SECRET,
      authUrl: e.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: e.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
      gmailBase: e.GMAIL_API_BASE || 'https://gmail.googleapis.com',
      driveBase: e.DRIVE_API_BASE || 'https://www.googleapis.com',
      driveUploadBase: e.DRIVE_UPLOAD_BASE || 'https://www.googleapis.com/upload',
    },
    reddit: {
      clientId: e.REDDIT_CLIENT_ID,
      clientSecret: e.REDDIT_CLIENT_SECRET,
      userAgent: e.REDDIT_USER_AGENT || 'poppet/0.1 (personal lead finder)',
      authUrl: e.REDDIT_AUTH_URL || 'https://www.reddit.com/api/v1/access_token',
      apiBase: e.REDDIT_API_BASE || 'https://oauth.reddit.com',
    },
    mcpRegistryUrl: e.MCP_REGISTRY_URL || 'https://registry.modelcontextprotocol.io',
    browser: {
      enabled: bool(e.POPPET_BROWSER, true),
      headless: bool(e.POPPET_BROWSER_HEADLESS, false),
      executablePath: e.POPPET_CHROME_PATH || undefined,
      port: Number(e.POPPET_BROWSER_PORT || 8931),
      allowFileUrls: bool(e.POPPET_BROWSER_ALLOW_FILE_URLS, false),
    },
    sandbox: {
      driver: (e.POPPET_SANDBOX as 'docker' | 'disabled') || 'docker',
      image: e.POPPET_SANDBOX_IMAGE || 'node:22-slim',
      timeoutMs: Number(e.POPPET_SANDBOX_TIMEOUT_MS || 60_000),
    },
    secretsDriver: (e.POPPET_SECRETS as PoppetConfig['secretsDriver']) || (process.platform === 'darwin' ? 'keychain' : 'file'),
    approvalTimeoutMs: Number(e.POPPET_APPROVAL_TIMEOUT_MS || 30 * 60_000),
    inboxPollMs: Number(e.POPPET_INBOX_POLL_MS || 5_000),
  };
}

export function workspacePath(...parts: string[]): string {
  return path.join(getConfig().home, ...parts);
}
