import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { builtinTools } from '../tools/builtin';
import type { ToolDef, ToolResult } from '../tools/types';
import type { Services } from '../services';
import type { ToolManifest } from '../registry';
import { USER_SECRET_PREFIX } from '../proposals';
import { BUILTIN_SERVER } from '../policy/policy';

type CallToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function toResult(r: ToolResult | string): CallToolResult {
  const t = typeof r === 'string' ? { text: r } : r;
  return { content: [{ type: 'text', text: t.text }], isError: t.isError };
}

/** Convert a JSON-Schema object into a zod raw shape for the SDK tool() helper. */
export function jsonSchemaToShape(schema: Record<string, any>): z.ZodRawShape {
  const props = (schema?.properties ?? {}) as Record<string, any>;
  const required = new Set<string>(schema?.required ?? []);
  const shape: Record<string, z.ZodType> = {};
  for (const [k, v] of Object.entries(props)) {
    let t: z.ZodType;
    try {
      t = z.fromJSONSchema(v) as z.ZodType;
    } catch {
      t = z.any();
    }
    shape[k] = required.has(k) ? t : t.optional();
  }
  return shape;
}

export function sandboxToolDef(manifest: ToolManifest, code: string): ToolDef<any> {
  return {
    name: `sandbox_tool_${manifest.name}`,
    description: `${manifest.description} (agent-written; runs in the sandbox)`,
    schema: jsonSchemaToShape(manifest.inputSchema),
    async handler(args, ctx) {
      const s = ctx.services;
      const granted: Record<string, string> = {};
      for (const name of s.registry.grantedSecrets(manifest.name)) {
        const v = await s.secrets.get(USER_SECRET_PREFIX + name);
        if (v !== undefined) granted[name] = v;
      }
      const r = await s.sandbox.run({ code }, args, granted);
      const health = s.registry.recordToolResult(manifest.name, r.ok);
      s.audit.write(ctx.convId, 'sandbox_run', { tool: manifest.name, ok: r.ok, durationMs: r.durationMs, error: r.error });
      if (!r.ok) {
        if (health === 'degraded')
          s.timeline.add(ctx.convId, {
            kind: 'notice',
            text: `Tool sandbox_tool_${manifest.name} failed 3 times in a row and is marked degraded.`,
          });
        return {
          text: `Tool failed: ${r.error}\n${r.logs}${health === 'degraded' ? '\nThis tool is now DEGRADED after 3 consecutive failures. Propose a fix with registry_propose_tool.' : ''}`,
          isError: true,
        };
      }
      return JSON.stringify(r.output, null, 2) + (r.logs.trim() ? `\n\nLogs:\n${r.logs.trim()}` : '');
    },
  };
}

/** All tools Poppet serves in-process for one conversation. */
export async function toolDefsFor(services: Services): Promise<ToolDef<any>[]> {
  const sandboxTools = (await services.registry.activeTools()).map((t) => sandboxToolDef(t.manifest, t.code));
  return [...builtinTools, ...sandboxTools];
}

export async function runToolDef(def: ToolDef<any>, args: unknown, ctx: Parameters<ToolDef['handler']>[1]) {
  try {
    const parsed = z.object(def.schema).parse(args ?? {});
    return toResult(await def.handler(parsed, ctx));
  } catch (e) {
    return toResult({ text: `Error: ${(e as Error)?.message ?? String(e)}`, isError: true });
  }
}

export function buildToolServer(defs: ToolDef<any>[], ctx: Parameters<ToolDef['handler']>[1]) {
  return createSdkMcpServer({
    name: BUILTIN_SERVER,
    version: '1.0.0',
    // Poppet's own tools are always in the prompt, never deferred behind tool search.
    alwaysLoad: true,
    tools: defs.map((d) => tool(d.name, d.description, d.schema, async (args) => (await runToolDef(d, args, ctx)) as any)),
  });
}
