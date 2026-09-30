import { marked } from 'marked';
import { getConfig } from '../config';
import type { SecretStore } from '../secrets';

export type GoogleAccount = 'personal' | 'agent';

export const GOOGLE_SCOPES: Record<GoogleAccount, string[]> = {
  // gmail.compose is needed for drafts.create; send stays behind approval.
  personal: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/drive.file',
  ],
  agent: ['https://www.googleapis.com/auth/gmail.modify'],
};

export class ReconnectError extends Error {
  constructor(public account: string) {
    super(`The ${account} Google account needs to be reconnected (Settings → Accounts).`);
  }
}

export interface MailSummary {
  id: string;
  threadId: string;
  from: string;
  to?: string;
  subject: string;
  date: string;
  snippet: string;
  unread: boolean;
  internalDate: number;
}

export interface MailFull extends MailSummary {
  body: string;
  links: string[];
}

const refreshKey = (a: GoogleAccount) => `google:${a}:refresh_token`;
const emailKey = (a: GoogleAccount) => `google:${a}:email`;

export class GoogleClient {
  private tokens = new Map<GoogleAccount, { token: string; exp: number }>();

  constructor(private secrets: SecretStore) {}

  authUrl(account: GoogleAccount, state: string): string {
    const c = getConfig();
    if (!c.google.clientId) throw new Error('GOOGLE_CLIENT_ID is not configured');
    const u = new URL(c.google.authUrl);
    u.searchParams.set('client_id', c.google.clientId);
    u.searchParams.set('redirect_uri', `${c.appUrl}/api/oauth/google/callback`);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', GOOGLE_SCOPES[account].join(' '));
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('prompt', 'consent');
    u.searchParams.set('state', state);
    return u.toString();
  }

  async exchangeCode(account: GoogleAccount, code: string): Promise<string> {
    const c = getConfig();
    const res = await fetch(c.google.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: c.google.clientId ?? '',
        client_secret: c.google.clientSecret ?? '',
        redirect_uri: `${c.appUrl}/api/oauth/google/callback`,
        grant_type: 'authorization_code',
      }),
    });
    if (!res.ok) throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
    const j = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    if (j.refresh_token) await this.secrets.set(refreshKey(account), j.refresh_token);
    this.tokens.set(account, { token: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 });
    const profile = await this.gmail<{ emailAddress: string }>(account, '/gmail/v1/users/me/profile');
    await this.secrets.set(emailKey(account), profile.emailAddress);
    return profile.emailAddress;
  }

  async status(): Promise<Record<GoogleAccount, { connected: boolean; email?: string }>> {
    const out = {} as Record<GoogleAccount, { connected: boolean; email?: string }>;
    for (const a of ['personal', 'agent'] as GoogleAccount[]) {
      out[a] = { connected: Boolean(await this.secrets.get(refreshKey(a))), email: await this.secrets.get(emailKey(a)) };
    }
    return out;
  }

  async disconnect(account: GoogleAccount) {
    this.tokens.delete(account);
    await this.secrets.delete(refreshKey(account));
    await this.secrets.delete(emailKey(account));
  }

  async email(account: GoogleAccount): Promise<string | undefined> {
    return this.secrets.get(emailKey(account));
  }

  private async accessToken(account: GoogleAccount): Promise<string> {
    const t = this.tokens.get(account);
    if (t && t.exp > Date.now()) return t.token;
    const refresh = await this.secrets.get(refreshKey(account));
    if (!refresh) throw new ReconnectError(account);
    const c = getConfig();
    const res = await fetch(c.google.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refresh,
        client_id: c.google.clientId ?? '',
        client_secret: c.google.clientSecret ?? '',
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) throw new ReconnectError(account);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    this.tokens.set(account, { token: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 });
    return j.access_token;
  }

  private async call<T>(account: GoogleAccount, url: string, init: RequestInit = {}, retried = false): Promise<T> {
    const token = await this.accessToken(account);
    const res = await fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` },
    });
    if (res.status === 401 && !retried) {
      this.tokens.delete(account);
      return this.call(account, url, init, true);
    }
    if (res.status === 401) throw new ReconnectError(account);
    if (!res.ok) throw new Error(`Google API ${res.status}: ${(await res.text()).slice(0, 500)}`);
    return (await res.json()) as T;
  }

  private gmail<T>(account: GoogleAccount, path: string, init?: RequestInit) {
    return this.call<T>(account, getConfig().google.gmailBase + path, init);
  }

  async search(account: GoogleAccount, q: string, max = 20): Promise<MailSummary[]> {
    const list = await this.gmail<{ messages?: { id: string }[] }>(
      account,
      `/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=${max}`,
    );
    const ids = (list.messages ?? []).map((m) => m.id);
    return Promise.all(
      ids.map(async (id) =>
        toSummary(
          await this.gmail<GmailMessage>(
            account,
            `/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
          ),
        ),
      ),
    );
  }

  async read(account: GoogleAccount, id: string): Promise<MailFull> {
    const m = await this.gmail<GmailMessage>(account, `/gmail/v1/users/me/messages/${id}?format=full`);
    const body = extractBody(m.payload);
    return { ...toSummary(m), body, links: extractLinks(body) };
  }

  async draft(account: GoogleAccount, msg: OutgoingMail): Promise<{ id: string }> {
    const raw = await this.rfc822(account, msg);
    return this.gmail(account, '/gmail/v1/users/me/drafts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: { raw } }),
    });
  }

  async send(account: GoogleAccount, msg: OutgoingMail): Promise<{ id: string }> {
    const raw = await this.rfc822(account, msg);
    return this.gmail(account, '/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ raw }),
    });
  }

  private async rfc822(account: GoogleAccount, m: OutgoingMail): Promise<string> {
    const from = await this.email(account);
    const lines = [
      from ? `From: ${from}` : undefined,
      `To: ${m.to}`,
      m.cc ? `Cc: ${m.cc}` : undefined,
      `Subject: ${m.subject}`,
      m.inReplyTo ? `In-Reply-To: ${m.inReplyTo}` : undefined,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      m.body,
    ].filter((l) => l !== undefined);
    return Buffer.from(lines.join('\r\n')).toString('base64url');
  }

  /** Markdown → HTML → Drive upload with conversion to a Google Doc. */
  async createDoc(title: string, markdown: string): Promise<{ id: string; url: string }> {
    const html = markdownToHtml(title, markdown);
    const boundary = 'poppet' + Math.random().toString(36).slice(2);
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify({ name: title, mimeType: 'application/vnd.google-apps.document' }) +
      `\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${html}\r\n--${boundary}--`;
    const r = await this.call<{ id: string; webViewLink?: string }>(
      'personal',
      `${getConfig().google.driveUploadBase}/drive/v3/files?uploadType=multipart&fields=id,webViewLink`,
      { method: 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body },
    );
    return { id: r.id, url: r.webViewLink ?? `https://docs.google.com/document/d/${r.id}/edit` };
  }

  async shareDoc(fileId: string, email: string, role: 'reader' | 'commenter' | 'writer') {
    return this.call(
      'personal',
      `${getConfig().google.driveBase}/drive/v3/files/${encodeURIComponent(fileId)}/permissions?sendNotificationEmail=true`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'user', role, emailAddress: email }),
      },
    );
  }
}

export interface OutgoingMail {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  inReplyTo?: string;
}

interface GmailPart {
  mimeType?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string };
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  snippet?: string;
  labelIds?: string[];
  internalDate?: string;
  payload: GmailPart;
}

function header(p: GmailPart, name: string) {
  return p.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function toSummary(m: GmailMessage): MailSummary {
  return {
    id: m.id,
    threadId: m.threadId,
    from: header(m.payload, 'From'),
    to: header(m.payload, 'To') || undefined,
    subject: header(m.payload, 'Subject'),
    date: header(m.payload, 'Date'),
    snippet: m.snippet ?? '',
    unread: (m.labelIds ?? []).includes('UNREAD'),
    internalDate: Number(m.internalDate ?? 0),
  };
}

function decode(data?: string) {
  return data ? Buffer.from(data, 'base64url').toString('utf8') : '';
}

export function extractBody(p: GmailPart): string {
  const plain: string[] = [];
  const html: string[] = [];
  const visit = (x: GmailPart) => {
    if (x.mimeType === 'text/plain') plain.push(decode(x.body?.data));
    else if (x.mimeType === 'text/html') html.push(decode(x.body?.data));
    x.parts?.forEach(visit);
  };
  visit(p);
  if (plain.length) return plain.join('\n');
  if (html.length) return htmlToText(html.join('\n'));
  return decode(p.body?.data);
}

export function htmlToText(h: string): string {
  return h
    .replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '$2 ($1)')
    .replace(/<(br|\/p|\/div|\/li|\/h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractLinks(text: string): string[] {
  return [...new Set([...text.matchAll(/https?:\/\/[^\s)<>"']+/g)].map((m) => m[0].replace(/[.,;]+$/, '')))];
}

export function markdownToHtml(title: string, md: string): string {
  const body = marked.parse(md, { async: false }) as string;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${body}</body></html>`;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
