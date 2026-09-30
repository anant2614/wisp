/**
 * The same scripted scenarios as fakeModel.ts, served over the OpenAI
 * Responses API so the Codex engine can be driven end to end. Poppet's tools
 * reach Codex through the MCP gateway (namespace "mcp__poppet"); this adapter
 * maps them to the canonical names scenarios use, and performs Codex's
 * tool_search step itself before calling a tool that isn't loaded yet.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import zlib from 'node:zlib';
import type { FakeModel, ModelCtx, Step, ToolCallRecord } from './fakeModel';

const NS = 'mcp__poppet';

/** Gateway tool name → canonical name (as the policy table and scenarios use). */
export function canonical(name: string): string {
  if (name.startsWith('browser_')) return `mcp__browser__${name}`;
  if (name.startsWith('ext_')) return `mcp__${name}`;
  return `mcp__poppet__${name}`;
}

/** Canonical name → gateway tool name (identifier-safe, as the gateway exposes it). */
export function gatewayName(canon: string): string {
  const m = canon.match(/^mcp__(.+?)__(.+)$/);
  if (!m) return canon;
  const name = m[1] === 'poppet' || m[1] === 'browser' ? m[2] : `${m[1]}__${m[2]}`;
  return name.replace(/[^A-Za-z0-9_]/g, '_');
}

function outputText(o: unknown): string {
  if (typeof o === 'string') return o;
  if (Array.isArray(o)) return o.map((x: any) => x?.text ?? '').join('\n');
  return JSON.stringify(o ?? '');
}

const ERROR_TEXT =
  /^(Error:|Blocked:|Unknown tool)|The user rejected|Poppet policy forbids|approval request expired|not in the official MCP registry/m;

export function buildResponsesCtx(body: any): { ctx: ModelCtx; loaded: Set<string>; searched: Set<string> } {
  const calls = new Map<string, { name: string; input: any }>();
  const all: ToolCallRecord[] = [];
  const userTexts: string[] = [];
  const system: string[] = [];
  const loaded = new Set<string>();
  const searched = new Set<string>();
  let turnStart = 0;
  for (const it of body.input ?? []) {
    if (it.type === 'message') {
      const texts = (it.content ?? []).map((c: any) => c.text ?? '').filter(Boolean) as string[];
      if (it.role === 'developer' || it.role === 'system') system.push(...texts);
      else if (it.role === 'user') {
        const real = texts.filter((t) => !t.trimStart().startsWith('<'));
        if (real.length) {
          userTexts.push(real.join('\n'));
          turnStart = all.length;
        }
      }
    } else if (it.type === 'function_call') {
      const name = it.namespace ? (it.namespace === NS ? canonical(it.name) : `${it.namespace}__${it.name}`) : it.name;
      calls.set(it.call_id, { name, input: safeJson(it.arguments) });
    } else if (it.type === 'function_call_output') {
      const c = calls.get(it.call_id);
      const text = outputText(it.output);
      all.push({ id: it.call_id, name: c?.name ?? '?', input: c?.input, text, isError: ERROR_TEXT.test(text) });
    } else if (it.type === 'tool_search_call') {
      searched.add(String(it.arguments?.query ?? ''));
    } else if (it.type === 'tool_search_output') {
      for (const group of it.tools ?? []) for (const t of group.tools ?? []) if (group.name === NS) loaded.add(canonical(t.name));
    }
  }
  for (const t of body.tools ?? []) if (t.type === 'function' && t.name) loaded.add(t.name);
  return {
    ctx: {
      prompt: userTexts[userTexts.length - 1] ?? '',
      userTexts,
      results: all.slice(turnStart),
      allResults: all,
      system: [body.instructions ?? '', ...system].join('\n'),
      tools: [...loaded],
    },
    loaded,
    searched,
  };
}

function safeJson(s: unknown) {
  try {
    return typeof s === 'string' ? JSON.parse(s) : s;
  } catch {
    return s;
  }
}

let seq = 0;
const id = (p: string) => `${p}_${Date.now().toString(36)}${(seq++).toString(36)}`;

export async function handleResponses(model: FakeModel, req: IncomingMessage, res: ServerResponse, path: string) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  let buf = Buffer.concat(chunks);
  const enc = req.headers['content-encoding'];
  if (enc === 'zstd') buf = (zlib as any).zstdDecompressSync(buf);
  else if (enc === 'gzip') buf = zlib.gunzipSync(buf);
  if (req.method !== 'POST' || !path.endsWith('/responses') || !buf.length) {
    res.writeHead(404).end();
    return;
  }
  const raw = buf.toString();
  model.requests.push(raw);
  model.auth.push({ authorization: req.headers.authorization as string | undefined });
  const body = JSON.parse(raw);
  const { ctx, loaded, searched } = buildResponsesCtx(body);
  const step: Step = model.decideCtx(ctx);

  let item: any;
  if ('text' in step) {
    item = {
      type: 'message',
      id: id('msg'),
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: step.text, annotations: [] }],
    };
  } else {
    const fname = gatewayName(step.tool);
    if (!loaded.has(canonical(fname)) && !searched.has(fname)) {
      // Codex defers MCP tools: load it via tool_search first, as a real model would.
      item = {
        type: 'tool_search_call',
        id: id('ts'),
        call_id: id('call'),
        execution: 'client',
        status: 'completed',
        arguments: { query: fname },
      };
    } else {
      item = {
        type: 'function_call',
        id: id('fc'),
        call_id: id('call'),
        name: fname,
        namespace: NS,
        arguments: JSON.stringify(step.input),
      };
    }
  }

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (d: any) => res.write(`event: ${d.type}\ndata: ${JSON.stringify(d)}\n\n`);
  const respId = id('resp');
  send({ type: 'response.created', response: { id: respId, status: 'in_progress' } });
  send({ type: 'response.output_item.added', output_index: 0, item: item.type === 'message' ? { ...item, content: [] } : item });
  if (item.type === 'message')
    for (const part of (item.content[0].text as string).match(/[\s\S]{1,40}/g) ?? [''])
      send({ type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: part });
  send({ type: 'response.output_item.done', output_index: 0, item });
  const out = Math.ceil(JSON.stringify(item).length / 4);
  send({
    type: 'response.completed',
    response: {
      id: respId,
      status: 'completed',
      usage: {
        input_tokens: Math.ceil(raw.length / 4),
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: out,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: Math.ceil(raw.length / 4) + out,
      },
    },
  });
  res.end();
}
