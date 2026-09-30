import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServices, type Services } from '@/server/services';
import { MemorySecretStore } from '@/server/secrets';
import { SECRET_KEYS } from '@/server/providers';
import { claudeEnv } from '@/server/agent/engines/claude';
import { P, type FakeModel } from '../fixtures/fakeModel';
import { startFakeModel, tempHome, testEnv, waitFor } from '../helpers';

/**
 * Model providers: Anthropic API key, Claude subscription, and OpenAI via Codex
 * (API key here; ChatGPT subscription sign-in is exercised up to the OAuth URL).
 */
describe('model providers', () => {
  let fake: Awaited<ReturnType<typeof startFakeModel>>;
  let model: FakeModel;
  let s: Services;
  const secrets = new MemorySecretStore();

  beforeAll(async () => {
    fake = await startFakeModel();
    model = fake.model;
    testEnv(tempHome(), {
      POPPET_ANTHROPIC_BASE_URL: fake.url,
      POPPET_OPENAI_BASE_URL: `${fake.url}/openai/v1`,
      OPENAI_API_KEY: 'sk-openai-test',
    });
    (globalThis as any).__poppet = undefined;
    s = createServices({ secrets });
    model.add({
      name: 'remember',
      match: (c) => /my favorite color/i.test(c.prompt) && !/previous model session/.test(c.prompt),
      next: (c) => (c.results.length === 0 ? { tool: P('memory_save'), input: { text: c.prompt } } : { text: 'Got it, teal.' }),
    });
    model.add({
      name: 'recall',
      match: (c) => /what did I say/i.test(c.prompt),
      next: (c) => ({ text: `Saw history: ${/favorite color is teal/.test(c.prompt) && /Got it, teal/.test(c.prompt)}` }),
    });
  });

  afterAll(async () => {
    await fake.close();
  });

  async function turn(convId: string, text: string) {
    s.sessions.startTurn(convId, text);
    await waitFor(() => !s.sessions.isRunning(convId), 90_000, 'turn to finish');
    const items = s.timeline.list(convId);
    return { items, last: items.filter((i) => i.kind === 'assistant' || i.kind === 'error').pop() as any };
  }

  it('Anthropic API key: sends the key', async () => {
    s.providers.select('anthropic_api');
    const conv = s.conversations.create();
    const n = model.auth.length;
    const { last } = await turn(conv.id, 'My favorite color is teal');
    expect(last.text).toBe('Got it, teal.');
    expect(model.auth.slice(n).every((a) => a.apiKey === 'sk-test')).toBe(true);
    expect(s.conversations.get(conv.id)!.engine).toBe('claude');
  });

  it('Claude subscription: uses the saved setup-token, never an API key', async () => {
    await secrets.set(SECRET_KEYS.claudeOauthToken, 'sk-ant-oat01-subscription-token');
    s.providers.select('claude_subscription');
    const env = await claudeEnv('claude_subscription', secrets);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-subscription-token');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();

    const conv = s.conversations.create();
    const n = model.auth.length;
    const { last } = await turn(conv.id, 'My favorite color is teal');
    expect(last.text).toBe('Got it, teal.');
    const used = model.auth.slice(n);
    expect(used.length).toBeGreaterThan(0);
    expect(used.every((a) => a.authorization === 'Bearer sk-ant-oat01-subscription-token' && !a.apiKey)).toBe(true);
    // Subscription usage is tracked in tokens but not billed.
    const u = s.conversations.usage(conv.id);
    expect(u.outputTokens).toBeGreaterThan(0);
    expect(u.costUsd).toBe(0);
  });

  it('Claude subscription without a token falls back to the local Claude Code login', async () => {
    await secrets.delete(SECRET_KEYS.claudeOauthToken);
    const env = await claudeEnv('claude_subscription', secrets);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    const st = (await s.providers.status()).find((x) => x.provider === 'claude_subscription')!;
    expect(st.detail).toContain('Claude Code login');
  });

  it('OpenAI via Codex: runs tools through the gateway and carries history across a provider switch', async () => {
    s.providers.select('anthropic_api');
    const conv = s.conversations.create();
    await turn(conv.id, 'My favorite color is teal');
    expect(s.conversations.get(conv.id)!.engine).toBe('claude');

    s.providers.select('openai_api');
    const n = model.auth.length;
    const { last, items } = await turn(conv.id, 'What did I say about colors?');
    expect(last.text).toBe('Saw history: true');
    expect(model.auth.slice(n).every((a) => a.authorization === 'Bearer sk-openai-test')).toBe(true);
    expect(s.conversations.get(conv.id)!.engine).toBe('codex');
    expect(s.conversations.get(conv.id)!.sdkSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(items.filter((i) => i.kind === 'notice')).toEqual([]);

    // Tools on the Codex engine go through Poppet's gateway and gate.
    const conv2 = s.conversations.create();
    const { last: l2, items: i2 } = await turn(conv2.id, 'My favorite color is teal');
    expect(l2.text).toBe('Got it, teal.');
    expect(i2.find((i) => i.kind === 'tool')).toMatchObject({ name: P('memory_save'), status: 'done' });
    expect(s.audit.recent().some((a) => a.event === 'tool_gate' && a.detail.toolName === P('memory_save'))).toBe(true);
  });

  it('ChatGPT subscription: refuses to run until signed in, then offers the sign-in flow', async () => {
    s.providers.select('openai_subscription');
    const conv = s.conversations.create();
    const { last } = await turn(conv.id, 'hello');
    expect(last.kind).toBe('error');
    expect(last.text).toContain('Sign in with ChatGPT');

    const url = await s.providers.startChatGptLogin();
    expect(url).toMatch(/^https:\/\/auth\.openai\.com\/oauth\/authorize\?/);
    expect(new URL(url).searchParams.get('redirect_uri')).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):1455\//);
    expect(s.providers.loginState().inProgress).toBe(true);
    s.providers.signOutChatGpt();
    await waitFor(() => !s.providers.loginState().inProgress, 10_000);
  });

  it('ChatGPT subscription: can import an existing Codex login', async () => {
    const userCodex = tempHome('codex-user-');
    fs.writeFileSync(path.join(userCodex, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: {} }));
    process.env.CODEX_HOME = userCodex;
    try {
      expect(s.providers.canImportCodexLogin()).toBe(true);
      s.providers.importCodexLogin();
      expect(s.providers.codexSignedIn()).toBe(true);
      expect(fs.statSync(path.join(s.providers.codexHome(), 'auth.json')).mode & 0o777).toBe(0o600);
      const st = (await s.providers.status()).find((x) => x.provider === 'openai_subscription')!;
      expect(st).toMatchObject({ ready: true, detail: 'Signed in with ChatGPT' });
    } finally {
      delete process.env.CODEX_HOME;
      s.providers.signOutChatGpt();
    }
  });
});
