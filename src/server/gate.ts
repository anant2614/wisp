import type { ApprovalManager } from './approvals';
import type { AuditLog } from './audit';
import { parseToolName, policyFor, BROWSER_SERVER, type ActionClass } from './policy/policy';
import { classifyClick, classifyFillForm, classifyKey, classifyType, type Classification } from './policy/snapshot';
import { redactSecrets, substituteSecrets, type SecretStore } from './secrets';

export interface BrowserProbe {
  /** A fresh ARIA snapshot of the current page (markdown with a ```yaml block). */
  snapshot(): Promise<string>;
  currentUrl(): Promise<string | undefined>;
}

export interface ToolPreview {
  title: string;
  markdown: string;
  /** Refuse without asking the user (e.g. a proposed tool whose tests fail). */
  autoDeny?: string;
}

/** Lets a tool render a richer approval card (diffs, test output) and react to rejection. */
export interface PreviewProvider {
  preview(tool: string, input: Record<string, unknown>, ctx: GateContext): Promise<ToolPreview | undefined>;
  rejected?(tool: string, input: Record<string, unknown>, ctx: GateContext, note?: string): Promise<void>;
}

export interface GateContext {
  convId: string;
  toolUseId: string;
  signal?: AbortSignal;
}

export type GateResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown>; cls: ActionClass; reason: string }
  | { behavior: 'deny'; message: string; cls: ActionClass; reason: string };

/**
 * The approval gate: deterministic code that decides allow / ask / deny for
 * every tool call, and blocks on the user's decision when it asks.
 */
export class ApprovalGate {
  private decided = new Map<string, Promise<GateResult>>();
  private secretUse = new Map<string, Map<string, string>>();
  /** One-shot grants for approvals decided after a restart (keyed conv + tool + input). */
  private carryOver = new Set<string>();

  constructor(
    private deps: {
      approvals: ApprovalManager;
      audit: AuditLog;
      secrets: SecretStore;
      browser?: BrowserProbe;
      previews?: PreviewProvider;
    },
  ) {}

  /** Idempotent per tool-use id: PreToolUse and canUseTool may both ask. */
  decide(ctx: GateContext, toolName: string, input: Record<string, unknown>): Promise<GateResult> {
    const existing = this.decided.get(ctx.toolUseId);
    if (existing) return existing;
    const p = this.decideInner(ctx, toolName, input).catch(
      (e): GateResult => ({
        behavior: 'deny',
        cls: 'forbidden',
        reason: 'error',
        message: `Blocked: ${String(e?.message ?? e)}`,
      }),
    );
    this.decided.set(ctx.toolUseId, p);
    // Keep the cache bounded.
    if (this.decided.size > 500) this.decided.delete(this.decided.keys().next().value!);
    return p;
  }

  grantCarryOver(convId: string, toolName: string, input: unknown) {
    this.carryOver.add(carryKey(convId, toolName, input));
  }

  private async decideInner(ctx: GateContext, toolName: string, input: Record<string, unknown>): Promise<GateResult> {
    const { audit } = this.deps;
    const entry = policyFor(toolName);
    const { server, tool } = parseToolName(toolName);
    let decision = entry.decision;
    let reason = `${entry.cls} → ${entry.decision}`;
    let target: Classification['target'];

    if (decision === 'classify') {
      const c = await this.classify(tool, input);
      decision = c.decision;
      reason = c.reason;
      target = c.target;
    }

    const key = carryKey(ctx.convId, toolName, input);
    if (decision === 'ask' && this.carryOver.has(key)) {
      this.carryOver.delete(key);
      decision = 'allow';
      reason = 'Approved by the user after a restart';
    }

    audit.write(ctx.convId, 'tool_gate', { toolName, toolUseId: ctx.toolUseId, cls: entry.cls, decision, reason, input });

    if (decision === 'deny') {
      return {
        behavior: 'deny',
        cls: entry.cls,
        reason,
        message: `Poppet policy forbids ${toolName}. This action is not available.`,
      };
    }

    if (decision === 'ask') {
      const custom: ToolPreview | undefined = await this.deps.previews?.preview(tool, input, ctx).catch((e) => ({
        title: `Run ${tool}`,
        markdown: `Preview failed: ${String(e?.message ?? e)}\n\n${genericPreview(input)}`,
      }));
      if (custom?.autoDeny) {
        audit.write(ctx.convId, 'tool_auto_denied', { toolName, reason: custom.autoDeny });
        return { behavior: 'deny', cls: entry.cls, reason: 'auto-denied', message: custom.autoDeny };
      }
      const title =
        custom?.title ??
        (server === BROWSER_SERVER ? browserTitle(tool, input, target) : `Allow ${tool}${server ? ` (${server})` : ''}?`);
      const markdown = custom?.markdown ?? `**Why approval is needed:** ${reason}\n\n${genericPreview(input)}`;
      const d = await this.deps.approvals.request(
        { convId: ctx.convId, toolName, title, input, previewMd: markdown },
        ctx.signal,
      );
      if (!d.approved) {
        await this.deps.previews?.rejected?.(tool, input, ctx, d.note).catch(() => {});
        const why =
          d.status === 'expired'
            ? 'The approval request expired after no response.'
            : `The user rejected this action.${d.note ? ` Their note: "${d.note}"` : ''}`;
        return { behavior: 'deny', cls: entry.cls, reason: d.status, message: `${why} Do not retry it unchanged.` };
      }
      reason = 'approved by user';
    }

    return { behavior: 'allow', cls: entry.cls, reason, updatedInput: await this.withSecrets(ctx, tool, server, input) };
  }

  private async classify(tool: string, input: Record<string, unknown>): Promise<Classification> {
    const probe = this.deps.browser;
    if (!probe) return { decision: 'ask', reason: 'No browser snapshot available' };
    let snap: string;
    try {
      snap = await probe.snapshot();
    } catch {
      return { decision: 'ask', reason: 'Could not read the page to classify this action' };
    }
    const ref = String(input.target ?? input.ref ?? '');
    switch (tool) {
      case 'browser_click':
        return classifyClick(snap, ref);
      case 'browser_type':
        return classifyType(snap, ref, Boolean(input.submit));
      case 'browser_fill_form': {
        const fields = (input.fields as Array<{ target?: string; ref?: string }>) ?? [];
        return classifyFillForm(
          snap,
          fields.map((f) => String(f.target ?? f.ref ?? '')),
        );
      }
      case 'browser_press_key':
        return classifyKey(snap, String(input.key ?? ''));
      default:
        return { decision: 'ask', reason: 'Unclassified browser action' };
    }
  }

  /**
   * Secret placeholders are only resolved for typing into web pages, only for
   * site:<domain> secrets, and only on that domain — so the model can never
   * route a stored credential anywhere else.
   */
  private async withSecrets(
    ctx: GateContext,
    tool: string,
    server: string | undefined,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const json = JSON.stringify(input);
    if (!json.includes('{{secret:')) return input;
    const allowed = server === BROWSER_SERVER && (tool === 'browser_type' || tool === 'browser_fill_form');
    if (!allowed) throw new Error(`Secret placeholders are not allowed in ${tool}`);
    const names = [...json.matchAll(/\{\{secret:([^}]+)\}\}/g)].map((m) => m[1]);
    const url = await this.deps.browser?.currentUrl();
    const host = url ? safeHost(url) : undefined;
    for (const n of names) {
      const domain = n.startsWith('site:') ? n.slice(5) : undefined;
      if (!domain || !host || !(host === domain || host.endsWith('.' + domain)))
        throw new Error(`Secret "${n}" cannot be used on ${host ?? 'this page'}`);
    }
    const { value, used } = await substituteSecrets(input, this.deps.secrets);
    this.secretUse.set(ctx.toolUseId, used);
    return value as Record<string, unknown>;
  }

  /** Called on tool output before the model sees it. */
  redact<T>(toolUseId: string, output: T): T {
    const used = this.secretUse.get(toolUseId);
    if (!used) return output;
    this.secretUse.delete(toolUseId);
    return redactSecrets(output, used);
  }

  hasSecrets(toolUseId: string): boolean {
    return this.secretUse.has(toolUseId);
  }
}

function carryKey(convId: string, toolName: string, input: unknown) {
  return `${convId}|${toolName}|${stableJson(input)}`;
}

export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

export function genericPreview(input: unknown): string {
  return '```json\n' + JSON.stringify(input, null, 2) + '\n```';
}

function browserTitle(tool: string, input: Record<string, unknown>, target?: { role: string; name: string }) {
  const what = target ? `${target.role} "${target.name}"` : String(input.element ?? input.target ?? '');
  switch (tool) {
    case 'browser_click':
      return `Click ${what}?`;
    case 'browser_type':
      return `Type into ${what}?`;
    case 'browser_fill_form':
      return 'Fill in this form?';
    case 'browser_press_key':
      return `Press ${String(input.key)}?`;
    case 'browser_file_upload':
      return 'Upload files to this page?';
    default:
      return `Allow ${tool}?`;
  }
}
