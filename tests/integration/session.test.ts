import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServices, type Services } from '@/server/services';
import { MemorySecretStore } from '@/server/secrets';
import { P, type FakeModel } from '../fixtures/fakeModel';
import { startFakeModel, tempHome, testEnv, waitFor } from '../helpers';

/**
 * Drives the real Claude Agent SDK (spawned CLI) through Poppet's session
 * manager against a scripted model: streaming, tool gating, approvals,
 * persistence and resume after a restart.
 */
describe('session manager with the Agent SDK', () => {
  let fake: Awaited<ReturnType<typeof startFakeModel>>;
  let model: FakeModel;
  let s: Services;
  let home: string;
  const secrets = new MemorySecretStore();

  beforeAll(async () => {
    fake = await startFakeModel();
    model = fake.model;
    home = tempHome();
    testEnv(home, { POPPET_ANTHROPIC_BASE_URL: fake.url });
    s = createServices({ secrets });

    model.add({
      name: 'remember',
      match: (c) => /remember that/i.test(c.prompt),
      next: (c) =>
        c.results.length === 0
          ? { tool: P('memory_save'), input: { text: c.prompt.replace(/^.*remember that /i, ''), tags: ['pref'] } }
          : { text: 'Noted — I will remember that.' },
    });
    model.add({
      name: 'recall',
      match: (c) => /what do you remember/i.test(c.prompt),
      next: (c) => ({
        text: `History has ${c.userTexts.length} user messages; first was: ${c.userTexts[0]}`,
      }),
    });
    model.add({
      name: 'send-mail',
      match: (c) => /email bob/i.test(c.prompt),
      next: (c) =>
        c.results.length === 0
          ? { tool: P('gmail_send'), input: { to: 'bob@example.com', subject: 'Hi', body: 'Hello Bob' } }
          : { text: c.results[0].isError ? `Not sent: ${c.results[0].text}` : 'Sent.' },
    });
    model.add({
      name: 'forbidden',
      match: (c) => /run a shell/i.test(c.prompt),
      next: (c) =>
        c.results.length === 0
          ? { tool: 'Bash', input: { command: 'ls /' } }
          : { text: `Result: ${c.results[0].text}` },
    });
  });

  afterAll(async () => {
    await fake.close();
  });

  async function turn(convId: string, text: string) {
    s.sessions.startTurn(convId, text);
    await waitFor(() => !s.sessions.isRunning(convId), 60_000, 'turn to finish');
    return s.timeline.list(convId);
  }

  it('runs a turn: tool call, streaming text, usage, persistence', async () => {
    const conv = s.conversations.create();
    const items = await turn(conv.id, 'Please remember that I prefer window seats');
    expect(model.errors).toEqual([]);
    const tool = items.find((i) => i.kind === 'tool');
    expect(tool).toMatchObject({ name: P('memory_save'), status: 'done', label: 'Saving a memory' });
    const reply = items.filter((i) => i.kind === 'assistant').pop();
    expect(reply).toMatchObject({ text: 'Noted — I will remember that.', streaming: false });
    expect(s.memory.search('window seats')[0].text).toContain('window seats');
    expect(s.conversations.get(conv.id)!.sdkSessionId).toBeTruthy();
    expect(s.conversations.get(conv.id)!.title).toBe('Please remember that I prefer window seats');
    expect(s.conversations.usage(conv.id).outputTokens).toBeGreaterThan(0);
    const audit = s.audit.recent().map((a) => a.event);
    expect(audit).toContain('tool_gate');
    expect(audit).toContain('tool_result');
  });

  it('injects relevant memories into the system prompt', async () => {
    const conv = s.conversations.create();
    await turn(conv.id, 'what do you remember about seats?');
    const last = JSON.parse(model.requests[model.requests.length - 1]);
    const sys = JSON.stringify(last.system);
    expect(sys).toContain('window seats');
    expect(sys).toContain('Relevant memories');
  });

  it('blocks on an approval card and honours a rejection note', async () => {
    const conv = s.conversations.create();
    s.sessions.startTurn(conv.id, 'email bob to say hi');
    const card = await waitFor(
      () => s.timeline.list(conv.id).find((i) => i.kind === 'approval' && i.status === 'pending'),
      30_000,
      'approval card',
    );
    if (card.kind !== 'approval') throw new Error();
    expect(card.title).toBe('Send email to bob@example.com?');
    expect(card.previewMd).toContain('Hello Bob');
    // Still blocked while pending.
    await new Promise((r) => setTimeout(r, 500));
    expect(s.sessions.isRunning(conv.id)).toBe(true);
    expect(s.approvals.decide(card.approvalId, false, 'too informal')).toBe(true);
    await waitFor(() => !s.sessions.isRunning(conv.id), 30_000);
    const items = s.timeline.list(conv.id);
    const reply = items.filter((i) => i.kind === 'assistant').pop()!;
    expect(reply.kind === 'assistant' && reply.text).toMatch(/Not sent: .*rejected.*too informal/);
    expect(items.find((i) => i.kind === 'tool')).toMatchObject({ status: 'denied' });
  });

  it('denies tools outside the policy (no shell access)', async () => {
    const conv = s.conversations.create();
    const items = await turn(conv.id, 'run a shell command');
    const reply = items.filter((i) => i.kind === 'assistant').pop()!;
    expect(reply.kind === 'assistant' && reply.text).not.toContain('bin');
    expect(s.timeline.list(conv.id).some((i) => i.kind === 'approval')).toBe(false);
  });

  it('resumes the SDK session after a server restart', async () => {
    const conv = s.conversations.create();
    await turn(conv.id, 'Please remember that my dog is called Rex');
    const sid = s.conversations.get(conv.id)!.sdkSessionId;
    // Simulate a restart: a fresh service graph over the same workspace.
    (globalThis as any).__poppet = undefined;
    s = createServices({ secrets });
    const items = await turn(conv.id, 'what do you remember?');
    const reply = items.filter((i) => i.kind === 'assistant').pop()!;
    expect(reply.kind === 'assistant' && reply.text).toContain('History has 2 user messages');
    expect(reply.kind === 'assistant' && reply.text).toContain('my dog is called Rex');
    expect(s.conversations.get(conv.id)!.sdkSessionId).toBe(sid);
  });
});
