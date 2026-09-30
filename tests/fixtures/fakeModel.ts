/**
 * A scripted stand-in for the Anthropic Messages API. It lets tests run the
 * real Claude Agent SDK, Poppet's gate, tools, browser and UI end to end while
 * replacing only the model's decisions with deterministic scenarios.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface ToolCallRecord {
  id: string;
  name: string;
  input: any;
  text: string;
  isError: boolean;
}

export interface ModelCtx {
  /** The prompt that started the current turn. */
  prompt: string;
  /** Every user text message in the conversation so far (oldest first). */
  userTexts: string[];
  /** Tool calls and results in the current turn, in order. */
  results: ToolCallRecord[];
  /** All tool calls across the whole conversation. */
  allResults: ToolCallRecord[];
  system: string;
  tools: string[];
}

export type Step = { tool: string; input: Record<string, unknown>; say?: string } | { text: string };

export interface Scenario {
  name: string;
  match: (ctx: ModelCtx) => boolean;
  next: (ctx: ModelCtx) => Step;
}

export const P = (t: string) => `mcp__poppet__${t}`;
export const B = (t: string) => `mcp__browser__${t}`;

/** Find the ref of an element in a Playwright snapshot by role and name. */
export function refOf(snapshot: string, role: string, name: RegExp): string {
  for (const line of snapshot.split('\n')) {
    const m = line.match(/- ([\w-]+)(?: "((?:[^"\\]|\\.)*)")?.*\[ref=([^\]]+)\]/);
    if (m && m[1] === role && name.test(m[2] ?? '')) return m[3];
  }
  throw new Error(`No ${role} ${name} in snapshot:\n${snapshot.slice(0, 1500)}`);
}

export function lastResult(ctx: ModelCtx, tool?: string): ToolCallRecord {
  const r = [...ctx.results].reverse().find((x) => !tool || x.name === tool);
  if (!r) throw new Error(`No result for ${tool}`);
  return r;
}

function textOf(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  return '';
}

export function buildCtx(body: any): ModelCtx {
  const msgs: any[] = body.messages ?? [];
  const calls = new Map<string, { name: string; input: any }>();
  const all: ToolCallRecord[] = [];
  const userTexts: string[] = [];
  let turnStart = 0;
  msgs.forEach((m, idx) => {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content ?? []);
    if (m.role === 'assistant')
      for (const b of blocks) if (b.type === 'tool_use') calls.set(b.id, { name: b.name, input: b.input });
    if (m.role === 'user') {
      const texts = blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text as string);
      const results = blocks.filter((b: any) => b.type === 'tool_result');
      for (const r of results) {
        const c = calls.get(r.tool_use_id);
        all.push({
          id: r.tool_use_id,
          name: c?.name ?? '?',
          input: c?.input,
          text: textOf(r.content),
          isError: Boolean(r.is_error),
        });
      }
      // A user message with real text (not only system reminders) starts a new turn.
      const real = texts.filter((t: string) => !/^<system-reminder>[\s\S]*<\/system-reminder>$/.test(t.trim()));
      if (!results.length && real.length) {
        userTexts.push(real.join('\n'));
        turnStart = all.length;
      }
    }
    void idx;
  });
  const system = Array.isArray(body.system) ? body.system.map((s: any) => s.text).join('\n') : (body.system ?? '');
  return {
    prompt: userTexts[userTexts.length - 1] ?? '',
    userTexts,
    results: all.slice(turnStart),
    allResults: all,
    system,
    tools: (body.tools ?? []).map((t: any) => t.name),
  };
}

export class FakeModel {
  scenarios: Scenario[] = [];
  /** Raw request bodies, so tests can assert what the model was (and wasn't) shown. */
  requests: string[] = [];
  /** Auth-related headers of each main-loop request (to verify which credential was used). */
  auth: { authorization?: string; apiKey?: string }[] = [];
  errors: string[] = [];

  add(...s: Scenario[]) {
    this.scenarios.push(...s);
  }

  decide(body: any): Step {
    return this.decideCtx(buildCtx(body));
  }

  decideCtx(ctx: ModelCtx): Step {
    const sc = this.scenarios.find((s) => s.match(ctx));
    if (!sc) return { text: `I have no script for: ${ctx.prompt.slice(0, 80)}` };
    try {
      return sc.next(ctx);
    } catch (e) {
      const msg = `[scenario ${sc.name} error] ${(e as Error).message}`;
      this.errors.push(msg);
      return { text: msg };
    }
  }

  async handle(req: IncomingMessage, res: ServerResponse, path: string) {
    let raw = '';
    for await (const c of req) raw += c;
    if (!path.startsWith('/v1/messages') || path.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 100 }));
      return;
    }
    const body = JSON.parse(raw || '{}');
    const isMain = (body.tools ?? []).some((t: any) => String(t.name).startsWith('mcp__poppet__'));
    this.requests.push(raw);
    if (isMain)
      this.auth.push({
        authorization: req.headers.authorization as string | undefined,
        apiKey: req.headers['x-api-key'] as string | undefined,
      });
    const step: Step = isMain ? this.decide(body) : { text: 'OK' };
    const content: any[] = [];
    if ('text' in step) content.push({ type: 'text', text: step.text });
    else {
      if (step.say) content.push({ type: 'text', text: step.say });
      content.push({
        type: 'tool_use',
        id: `toolu_${Math.random().toString(36).slice(2, 12)}`,
        name: step.tool,
        input: step.input,
      });
    }
    const stop = 'tool' in step ? 'tool_use' : 'end_turn';
    const msg = {
      id: `msg_${Math.random().toString(36).slice(2, 12)}`,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [] as any[],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: Math.ceil(raw.length / 4), output_tokens: 0 },
    };
    const outTokens = Math.ceil(JSON.stringify(content).length / 4);
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...msg, content, stop_reason: stop, usage: { ...msg.usage, output_tokens: outTokens } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (e: string, d: object) => res.write(`event: ${e}\ndata: ${JSON.stringify({ type: e, ...d })}\n\n`);
    send('message_start', { message: msg });
    content.forEach((b, i) => {
      if (b.type === 'text') {
        send('content_block_start', { index: i, content_block: { type: 'text', text: '' } });
        // Stream in a few chunks to exercise incremental rendering.
        const parts = b.text.match(/[\s\S]{1,40}/g) ?? [''];
        for (const p of parts) send('content_block_delta', { index: i, delta: { type: 'text_delta', text: p } });
      } else {
        send('content_block_start', { index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
        send('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
      }
      send('content_block_stop', { index: i });
    });
    send('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: outTokens } });
    send('message_stop', {});
    res.end();
  }
}
