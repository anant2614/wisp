import { getConfig } from '../config';

export interface RedditItem {
  kind: 'post' | 'comment';
  id: string;
  url: string;
  author: string;
  subreddit: string;
  title?: string;
  text: string;
  createdUtc: number;
  score: number;
  numComments?: number;
}

export type TimeRange = 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';

export class RedditUnavailableError extends Error {}

/**
 * Read-only client for Reddit's official Data API (application-only OAuth,
 * "script" app). There are deliberately no write methods (FR-15).
 */
export class RedditClient {
  private token?: { value: string; exp: number };
  private resetAt = 0;
  private remaining = Infinity;

  constructor(private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {}

  configured(): boolean {
    const c = getConfig().reddit;
    return Boolean(c.clientId && c.clientSecret);
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.exp > Date.now()) return this.token.value;
    const c = getConfig().reddit;
    if (!c.clientId || !c.clientSecret) throw new RedditUnavailableError('Reddit API credentials are not configured');
    const res = await fetch(c.authUrl, {
      method: 'POST',
      headers: {
        authorization: 'Basic ' + Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64'),
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': c.userAgent,
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
    });
    if (!res.ok) throw new RedditUnavailableError(`Reddit auth failed: ${res.status}`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
    return j.access_token;
  }

  private async get(path: string, attempt = 0): Promise<any> {
    // Respect X-Ratelimit-* headers: wait for the window to reset when exhausted.
    if (this.remaining < 1 && Date.now() < this.resetAt) await this.sleep(this.resetAt - Date.now());
    const c = getConfig().reddit;
    const res = await fetch(c.apiBase + path, {
      headers: { authorization: `Bearer ${await this.accessToken()}`, 'user-agent': c.userAgent },
    });
    const rem = res.headers.get('x-ratelimit-remaining');
    const reset = res.headers.get('x-ratelimit-reset');
    if (rem !== null) this.remaining = Number(rem);
    if (reset !== null) this.resetAt = Date.now() + Number(reset) * 1000;
    if (res.status === 429 && attempt < 3) {
      await this.sleep(Math.max(1000, Number(reset ?? 2) * 1000));
      return this.get(path, attempt + 1);
    }
    if (res.status === 401 && attempt < 1) {
      this.token = undefined;
      return this.get(path, attempt + 1);
    }
    if (res.status >= 500 || res.status === 403) throw new RedditUnavailableError(`Reddit API ${res.status}`);
    if (!res.ok) throw new Error(`Reddit API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }

  async search(query: string, opts: { subreddits?: string[]; timeRange?: TimeRange; limit?: number } = {}) {
    const t = opts.timeRange ?? 'month';
    const limit = Math.min(opts.limit ?? 25, 100);
    const subs = opts.subreddits?.filter(Boolean) ?? [];
    const paths = subs.length
      ? subs.map(
          (s) =>
            `/r/${encodeURIComponent(s.replace(/^r\//, ''))}/search?q=${encodeURIComponent(query)}&restrict_sr=1&sort=relevance&t=${t}&limit=${limit}&raw_json=1`,
        )
      : [`/search?q=${encodeURIComponent(query)}&sort=relevance&t=${t}&limit=${limit}&raw_json=1`];
    const out: RedditItem[] = [];
    for (const p of paths) {
      const j = await this.get(p);
      for (const child of j?.data?.children ?? []) {
        const d = child.data;
        out.push({
          kind: child.kind === 't1' ? 'comment' : 'post',
          id: d.name ?? d.id,
          url: d.permalink ? `https://www.reddit.com${d.permalink}` : d.url,
          author: d.author ?? '[deleted]',
          subreddit: d.subreddit ?? '',
          title: d.title,
          text: (d.selftext ?? d.body ?? '').slice(0, 2000),
          createdUtc: d.created_utc ?? 0,
          score: d.score ?? 0,
          numComments: d.num_comments,
        });
      }
    }
    const seen = new Set<string>();
    return out.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
  }
}
