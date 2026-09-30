import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { GoogleClient, ReconnectError } from '@/server/integrations/google';
import { RedditClient, RedditUnavailableError } from '@/server/integrations/reddit';
import { searchIntegrations, findIntegration } from '@/server/integrations/mcpRegistry';
import { MemorySecretStore } from '@/server/secrets';

const G = 'https://gmail.test';
const T = 'https://oauth.test/token';
const R = 'https://reddit.test';

const b64 = (s: string) => Buffer.from(s).toString('base64url');
let tokenCalls = 0;
let gmailAuth: string[] = [];
let uploads: { contentType: string | null; body: string }[] = [];
const server = setupServer(
  http.post(T, async ({ request }) => {
    tokenCalls++;
    const f = new URLSearchParams(await request.text());
    if (f.get('refresh_token') === 'revoked') return HttpResponse.json({ error: 'invalid_grant' }, { status: 400 });
    return HttpResponse.json({ access_token: `at-${tokenCalls}`, expires_in: 3600 });
  }),
  http.get(`${G}/gmail/v1/users/me/messages`, ({ request }) => {
    gmailAuth.push(request.headers.get('authorization') ?? '');
    // First call with a stale token → 401, which must trigger a refresh.
    if (request.headers.get('authorization') === 'Bearer at-1' && gmailAuth.length === 1)
      return new HttpResponse(null, { status: 401 });
    return HttpResponse.json({ messages: [{ id: 'm1' }] });
  }),
  http.get(`${G}/gmail/v1/users/me/messages/m1`, () =>
    HttpResponse.json({
      id: 'm1',
      threadId: 't1',
      snippet: 'Your order',
      labelIds: ['UNREAD'],
      internalDate: '1700000000000',
      payload: {
        headers: [
          { name: 'From', value: 'shop@x.com' },
          { name: 'Subject', value: 'Order 1' },
        ],
        parts: [{ mimeType: 'text/plain', body: { data: b64('Track: https://x.com/o/1') } }],
      },
    }),
  ),
  http.post(`${G}/upload/drive/v3/files`, async ({ request }) => {
    uploads.push({ contentType: request.headers.get('content-type'), body: await request.text() });
    return HttpResponse.json({ id: 'doc1', webViewLink: 'https://docs.google.com/document/d/doc1/edit' });
  }),
  http.post(`${R}/token`, () => HttpResponse.json({ access_token: 'rt', expires_in: 3600 })),
  http.get(`${R}/api/r/:sub/search`, ({ params, request }) => {
    const u = new URL(request.url);
    if (params.sub === 'ratelimited' && !u.searchParams.has('retried')) {
      rateLimited++;
      if (rateLimited === 1)
        return new HttpResponse(null, { status: 429, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2' } });
    }
    if (params.sub === 'down') return new HttpResponse(null, { status: 503 });
    return HttpResponse.json(
      {
        data: {
          children: [
            {
              kind: 't3',
              data: {
                name: 't3_a',
                title: 'Looking for X',
                selftext: 'help',
                author: 'u1',
                subreddit: params.sub,
                permalink: '/r/x/1',
                created_utc: 1,
                score: 3,
              },
            },
            {
              kind: 't3',
              data: {
                name: 't3_a',
                title: 'dup',
                selftext: '',
                author: 'u1',
                subreddit: params.sub,
                permalink: '/r/x/1',
                created_utc: 1,
                score: 3,
              },
            },
          ],
        },
      },
      { headers: { 'x-ratelimit-remaining': '50', 'x-ratelimit-reset': '10' } },
    );
  }),
  http.get('https://registry.test/v0/servers', ({ request }) => {
    const q = new URL(request.url).searchParams.get('search');
    return HttpResponse.json({
      servers:
        q === 'notion' || q === 'com.notion/mcp'
          ? [
              {
                server: {
                  name: 'com.notion/mcp',
                  description: 'Notion',
                  version: '1.0.0',
                  remotes: [{ type: 'streamable-http', url: 'https://mcp.notion.test/mcp' }],
                  packages: [
                    {
                      registryType: 'npm',
                      identifier: '@notionhq/notion-mcp-server',
                      version: '1.9.0',
                      environmentVariables: [{ name: 'NOTION_TOKEN', isSecret: true }],
                    },
                  ],
                },
              },
            ]
          : [],
    });
  }),
);
let rateLimited = 0;

beforeAll(() => {
  Object.assign(process.env, {
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'cs',
    GOOGLE_TOKEN_URL: T,
    GMAIL_API_BASE: G,
    DRIVE_UPLOAD_BASE: `${G}/upload`,
    REDDIT_CLIENT_ID: 'r',
    REDDIT_CLIENT_SECRET: 's',
    REDDIT_AUTH_URL: `${R}/token`,
    REDDIT_API_BASE: `${R}/api`,
    MCP_REGISTRY_URL: 'https://registry.test',
  });
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('Google client (recorded fixtures)', () => {
  it('refreshes tokens, retries a 401 once, and parses messages', async () => {
    const secrets = new MemorySecretStore();
    await secrets.set('google:personal:refresh_token', 'rt');
    const g = new GoogleClient(secrets);
    const list = await g.search('personal', 'is:unread');
    expect(list[0]).toMatchObject({ id: 'm1', from: 'shop@x.com', subject: 'Order 1', unread: true });
    expect(gmailAuth).toEqual(['Bearer at-1', 'Bearer at-2']);
    const full = await g.read('personal', 'm1');
    expect(full.links).toEqual(['https://x.com/o/1']);
  });

  it('asks the user to reconnect when there is no token or refresh fails', async () => {
    const g = new GoogleClient(new MemorySecretStore());
    await expect(g.search('agent', 'x')).rejects.toBeInstanceOf(ReconnectError);
    const s = new MemorySecretStore();
    await s.set('google:agent:refresh_token', 'revoked');
    await expect(new GoogleClient(s).search('agent', 'x')).rejects.toBeInstanceOf(ReconnectError);
  });

  it('creates a Google Doc by uploading converted HTML', async () => {
    const secrets = new MemorySecretStore();
    await secrets.set('google:personal:refresh_token', 'rt');
    uploads = [];
    const d = await new GoogleClient(secrets).createDoc('Report', '# Hi\n\n| a | b |\n|---|---|\n| 1 | 2 |');
    expect(d.url).toBe('https://docs.google.com/document/d/doc1/edit');
    expect(uploads[0].contentType).toMatch(/^multipart\/related; boundary=/);
    expect(uploads[0].body).toContain('"mimeType":"application/vnd.google-apps.document"');
    expect(uploads[0].body).toContain('<h1>Hi</h1>');
    expect(uploads[0].body).toContain('<table>');
  });
});

describe('Reddit client (recorded fixtures)', () => {
  it('searches subreddits read-only and dedupes', async () => {
    const r = new RedditClient();
    const items = await r.search('looking for x', { subreddits: ['smallbusiness', 'r/freelance'] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ url: 'https://www.reddit.com/r/x/1', author: 'u1' });
  });

  it('backs off on 429 using X-Ratelimit-Reset', async () => {
    const waits: number[] = [];
    const r = new RedditClient(async (ms) => void waits.push(ms));
    rateLimited = 0;
    const items = await r.search('x', { subreddits: ['ratelimited'] });
    expect(items).toHaveLength(1);
    expect(waits[0]).toBe(2000);
  });

  it('reports unavailability so the agent can fall back to the browser', async () => {
    await expect(new RedditClient().search('x', { subreddits: ['down'] })).rejects.toBeInstanceOf(RedditUnavailableError);
  });
});

describe('MCP registry client', () => {
  it('normalises remotes and npm packages', async () => {
    const [c] = await searchIntegrations('notion');
    expect(c.remotes[0]).toMatchObject({ type: 'streamable-http', url: 'https://mcp.notion.test/mcp' });
    expect(c.packages[0]).toMatchObject({ identifier: '@notionhq/notion-mcp-server', version: '1.9.0' });
    expect(await findIntegration('com.notion/mcp')).toBeTruthy();
    expect(await findIntegration('io.evil/stealer')).toBeUndefined();
  });
});
