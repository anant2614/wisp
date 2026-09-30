import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '@/server/db';
import { InMemoryEventBus } from '@/server/events';
import { Timeline } from '@/server/timeline';
import { AuditLog } from '@/server/audit';
import { ApprovalManager } from '@/server/approvals';
import { ApprovalGate, type BrowserProbe, type PreviewProvider } from '@/server/gate';
import { MemorySecretStore, redactSecrets, substituteSecrets } from '@/server/secrets';

const signup = fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'snapshots', 'signup.md'), 'utf8');

function setup(opts: { url?: string; previews?: PreviewProvider; timeoutMs?: number } = {}) {
  const db = openDb(':memory:');
  const bus = new InMemoryEventBus();
  const timeline = new Timeline(db, bus);
  const audit = new AuditLog(db);
  const approvals = new ApprovalManager(db, timeline, audit, opts.timeoutMs ?? 60_000);
  const secrets = new MemorySecretStore();
  const browser: BrowserProbe = {
    snapshot: async () => signup.replace('https://app.example.com/signup', opts.url ?? 'https://app.example.com/signup'),
    currentUrl: async () => opts.url ?? 'https://app.example.com/signup',
  };
  const gate = new ApprovalGate({ approvals, audit, secrets, browser, previews: opts.previews });
  return { db, timeline, audit, approvals, secrets, gate };
}

let n = 0;
const ctx = () => ({ convId: 'c1', toolUseId: `tu${++n}` });

async function pendingApproval(approvals: ApprovalManager) {
  for (let i = 0; i < 100; i++) {
    const p = approvals.pending('c1');
    if (p.length) return p[0];
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('no approval requested');
}

describe('approval gate', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it('allows reads without asking and audits them', async () => {
    const r = await t.gate.decide(ctx(), 'mcp__poppet__gmail_search', { query: 'x' });
    expect(r.behavior).toBe('allow');
    expect(t.approvals.pending()).toHaveLength(0);
    expect(t.audit.recent()[0]).toMatchObject({ event: 'tool_gate' });
  });

  it('denies forbidden tools', async () => {
    const r = await t.gate.decide(ctx(), 'Bash', { command: 'rm -rf /' });
    expect(r.behavior).toBe('deny');
  });

  it('asks for outbound email and allows on approval', async () => {
    const p = t.gate.decide(ctx(), 'mcp__poppet__gmail_send', { to: 'a@b.c', subject: 's', body: 'b' });
    const a = await pendingApproval(t.approvals);
    const card = t.timeline.list('c1').find((i) => i.kind === 'approval')!;
    expect(card).toMatchObject({ status: 'pending', toolName: 'mcp__poppet__gmail_send' });
    t.approvals.decide(a.id, true);
    expect((await p).behavior).toBe('allow');
    expect(t.timeline.list('c1').find((i) => i.kind === 'approval')).toMatchObject({ status: 'approved' });
  });

  it('passes the rejection note back to the model', async () => {
    const p = t.gate.decide(ctx(), 'mcp__poppet__gmail_send', { to: 'a@b.c', subject: 's', body: 'b' });
    t.approvals.decide((await pendingApproval(t.approvals)).id, false, 'wrong recipient');
    const r = await p;
    expect(r.behavior).toBe('deny');
    expect(r.behavior === 'deny' && r.message).toContain('wrong recipient');
  });

  it('expires unanswered approvals as rejections', async () => {
    const t2 = setup({ timeoutMs: 30 });
    const r = await t2.gate.decide(ctx(), 'mcp__poppet__gmail_send', { to: 'a@b.c', subject: 's', body: 'b' });
    expect(r.behavior === 'deny' && r.message).toContain('expired');
    expect(t2.approvals.pending()).toHaveLength(0);
  });

  it('classifies browser clicks against a fresh snapshot', async () => {
    expect((await t.gate.decide(ctx(), 'mcp__browser__browser_click', { target: 'e3', element: 'Pricing' })).behavior).toBe(
      'allow',
    );
    const p = t.gate.decide(ctx(), 'mcp__browser__browser_click', { target: 'e13', element: 'Create account' });
    const a = await pendingApproval(t.approvals);
    expect(a.previewMd).toContain('Create account');
    t.approvals.decide(a.id, true);
    expect((await p).behavior).toBe('allow');
  });

  it('is idempotent per tool-use id (hook + canUseTool)', async () => {
    const c = ctx();
    const a = t.gate.decide(c, 'mcp__poppet__gmail_send', { to: 'x', subject: 'y', body: 'z' });
    const b = t.gate.decide(c, 'mcp__poppet__gmail_send', { to: 'x', subject: 'y', body: 'z' });
    t.approvals.decide((await pendingApproval(t.approvals)).id, true);
    expect(await a).toBe(await b);
    expect(t.approvals.pending()).toHaveLength(0);
  });

  it('substitutes site secrets only on the matching domain, and redacts output', async () => {
    await t.secrets.set('site:app.example.com', 'S3cret-Passw0rd!');
    const input = { target: 'e10', text: '{{secret:site:app.example.com}}' };
    const c = ctx();
    const p = t.gate.decide(c, 'mcp__browser__browser_type', input);
    const a = await pendingApproval(t.approvals);
    expect(a.inputJson).toContain('{{secret:site:app.example.com}}');
    expect(a.inputJson).not.toContain('S3cret');
    t.approvals.decide(a.id, true);
    const r = await p;
    expect(r.behavior === 'allow' && r.updatedInput.text).toBe('S3cret-Passw0rd!');
    const out = t.gate.redact(c.toolUseId, { content: [{ type: 'text', text: "fill('S3cret-Passw0rd!')" }] });
    expect(JSON.stringify(out)).not.toContain('S3cret');
    expect(JSON.stringify(out)).toContain('{{secret:site:app.example.com}}');
  });

  it('refuses secrets on another domain or in other tools', async () => {
    const other = setup({ url: 'https://evil.example.net/login' });
    await other.secrets.set('site:app.example.com', 'S3cret-Passw0rd!');
    const p = other.gate.decide(ctx(), 'mcp__browser__browser_type', { target: 'e6', text: '{{secret:site:app.example.com}}' });
    other.approvals.decide((await pendingApproval(other.approvals)).id, true);
    const r = await p;
    expect(r.behavior).toBe('deny');
    expect(r.behavior === 'deny' && r.message).toContain('cannot be used');

    await t.secrets.set('site:app.example.com', 'S3cret-Passw0rd!');
    const q = t.gate.decide(ctx(), 'mcp__poppet__gmail_send', {
      to: 'a@b.c',
      subject: 'pw',
      body: '{{secret:site:app.example.com}}',
    });
    t.approvals.decide((await pendingApproval(t.approvals)).id, true);
    expect((await q).behavior).toBe('deny');
  });

  it('lets a preview auto-deny without asking', async () => {
    const t3 = setup({ previews: { preview: async () => ({ title: '', markdown: '', autoDeny: 'tests failed' }) } });
    const r = await t3.gate.decide(ctx(), 'mcp__poppet__registry_propose_tool', {});
    expect(r).toMatchObject({ behavior: 'deny', message: 'tests failed' });
    expect(t3.approvals.pending()).toHaveLength(0);
  });

  it('honours a carry-over grant once (approval decided after a restart)', async () => {
    const input = { to: 'a@b.c', subject: 's', body: 'b' };
    t.gate.grantCarryOver('c1', 'mcp__poppet__gmail_send', input);
    expect((await t.gate.decide(ctx(), 'mcp__poppet__gmail_send', input)).behavior).toBe('allow');
    const again = t.gate.decide(ctx(), 'mcp__poppet__gmail_send', input);
    expect(await pendingApproval(t.approvals)).toBeTruthy();
    t.approvals.decide(t.approvals.pending()[0].id, false);
    expect((await again).behavior).toBe('deny');
  });
});

describe('approvals after a restart', () => {
  it('keep pending approvals pending and resume the task when decided', async () => {
    const t = setup();
    void t.approvals.request({ convId: 'c1', toolName: 'mcp__poppet__gmail_send', title: 'x', input: { a: 1 }, previewMd: '' });
    const row = await pendingApproval(t.approvals);
    // A new manager over the same DB has no live waiter for it.
    const bus = new InMemoryEventBus();
    const fresh = new ApprovalManager(t.db, new Timeline(t.db, bus), new AuditLog(t.db), 60_000);
    const decided: unknown[] = [];
    fresh.onOrphanDecision = (r, d) => decided.push([r.id, d.approved]);
    fresh.restoreOrphans();
    expect(fresh.pending()).toHaveLength(1);
    expect(fresh.decide(row.id, true)).toBe(true);
    expect(decided).toEqual([[row.id, true]]);
  });
});

describe('secret helpers', () => {
  it('substitute and redact round-trip, including JSON-escaped forms', async () => {
    const s = new MemorySecretStore();
    await s.set('site:a.com', 'p"ss\\word');
    const { value, used } = await substituteSecrets({ fields: [{ value: 'x {{secret:site:a.com}}' }] }, s);
    expect(JSON.stringify(value)).toContain('p\\"ss\\\\word');
    const leaked = `typed "${JSON.stringify('p"ss\\word').slice(1, -1)}" and p"ss\\word`;
    expect(redactSecrets(leaked, used)).toBe('typed "{{secret:site:a.com}}" and {{secret:site:a.com}}');
  });
  it('rejects unknown secrets', async () => {
    await expect(substituteSecrets('{{secret:nope}}', new MemorySecretStore())).rejects.toThrow('Unknown secret');
  });
});
