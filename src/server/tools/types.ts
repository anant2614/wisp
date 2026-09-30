import type { z } from 'zod';
import type { Services } from '../services';

export interface ToolContext {
  convId: string;
  services: Services;
  signal?: AbortSignal;
}

export interface ToolResult {
  text: string;
  isError?: boolean;
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  schema: S;
  handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<ToolResult | string>;
}

export function defineTool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

/** Wrap text from the outside world so the model treats it as data, not instructions. */
export function untrusted(source: string, text: string): string {
  return `<untrusted_content source="${source}">\n${text.replace(/<\/?untrusted_content[^>]*>/g, '')}\n</untrusted_content>`;
}
