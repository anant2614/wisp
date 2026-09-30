/**
 * Parsing and classification of Playwright MCP ARIA snapshots.
 *
 * A snapshot looks like:
 *   - generic [ref=e4]:
 *     - textbox "Email" [ref=e6]
 *     - button "Create account" [ref=e9]
 *
 * Everything here is deterministic string/tree logic — no model judgement.
 */

export interface SnapNode {
  role: string;
  name: string;
  ref?: string;
  attrs: string[];
  text?: string;
  depth: number;
  parent?: SnapNode;
  children: SnapNode[];
}

const LINE = /^(\s*)- (.*)$/;

export function extractSnapshotYaml(text: string): string {
  const m = text.match(/```yaml\n([\s\S]*?)```/);
  return m ? m[1] : text;
}

export function parseSnapshot(text: string): SnapNode[] {
  const yaml = extractSnapshotYaml(text);
  const roots: SnapNode[] = [];
  const stack: SnapNode[] = [];
  for (const raw of yaml.split('\n')) {
    const m = raw.match(LINE);
    if (!m) continue;
    const depth = m[1].length;
    const body = m[2];
    if (body.startsWith('/')) continue; // property line such as "- /url: /about"
    // role ["name"] [attr]* [: text]   e.g.  paragraph [ref=f1e2]: captcha
    const tok = body.match(/^([\w-]+)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]*\])*)(?::(?: (.*))?)?$/);
    const role = tok ? tok[1] : (body.match(/^([\w-]+)/) || [, ''])[1]!;
    const name = tok?.[2] ?? '';
    const attrText = tok?.[3] ?? '';
    const text = tok?.[4]?.replace(/^"|"$/g, '');
    const ref = (attrText.match(/\[ref=([^\]]+)\]/) || [])[1];
    const attrs = [...attrText.matchAll(/\[([^\]=]+)(?:=[^\]]*)?\]/g)].map((a) => a[1]);
    const node: SnapNode = { role, name: name.replace(/\\"/g, '"'), ref, attrs, text, depth, children: [] };
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) {
      node.parent = parent;
      parent.children.push(node);
    } else roots.push(node);
    stack.push(node);
  }
  return roots;
}

function* walk(nodes: SnapNode[]): Generator<SnapNode> {
  for (const n of nodes) {
    yield n;
    yield* walk(n.children);
  }
}

export function findByRef(nodes: SnapNode[], ref: string): SnapNode | undefined {
  for (const n of walk(nodes)) if (n.ref === ref) return n;
  return undefined;
}

const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'checkbox', 'radio', 'switch', 'slider']);
const SENSITIVE_FIELD =
  /pass(word|code|phrase)?|e-?mail|card|cvv|cvc|security code|expir|iban|routing|account number|ssn|social security|phone|mobile|otp|one[- ]time|verification code/i;
const SUBMIT_WORDS =
  /\b(submit|sign ?up|register|create|log ?in|sign ?in|continue|next|confirm|send|post|publish|buy|purchase|pay|order|checkout|check out|subscribe|delete|remove|save|apply|join|verify|agree|place|book|reserve|donate|transfer|upload|finish|complete|get started|start trial|unsubscribe|cancel (my )?(account|subscription))\b/i;
const SAFE_BUTTON =
  /^((show|hide) password|search|show (more|less|all)|load more|see (more|all)|read more|view( more| all| details)?|more|less|next page|previous( page)?|prev|back|close|dismiss|menu|open menu|expand|collapse|toggle|details|sort( by)?.*|filter.*|(accept|reject|decline)( all)?( cookies)?|got it|ok|okay|no thanks|not now|skip|zoom( in| out)?|play|pause|share options|copy link|page \d+|\d+)$/i;
const DANGEROUS_LINK =
  /\b(sign ?out|log ?out|delete|unsubscribe|buy|purchase|pay|checkout|check out|order now|cancel (my )?(account|subscription))\b/i;

function subtreeFields(n: SnapNode): SnapNode[] {
  return [...walk(n.children)].filter((c) => FIELD_ROLES.has(c.role));
}

/**
 * The nearest form ancestor, or the smallest ancestor that groups input fields
 * with the target. The page root is never a form group (it contains every
 * field on the page), and search boxes don't make a group a form.
 */
export function formContext(node: SnapNode): SnapNode | undefined {
  let cur = node.parent;
  let hops = 0;
  while (cur && cur.parent && hops < 5) {
    if (cur.role === 'form') return cur;
    if (subtreeFields(cur).some((f) => f !== node && f.role !== 'searchbox')) return cur;
    cur = cur.parent;
    hops++;
  }
  return cur?.role === 'form' ? cur : undefined;
}

function isSensitiveField(n: SnapNode): boolean {
  return FIELD_ROLES.has(n.role) && n.role !== 'searchbox' && SENSITIVE_FIELD.test(n.name);
}

export function formIsSensitive(form: SnapNode | undefined): boolean {
  if (!form) return false;
  return subtreeFields(form).some(isSensitiveField);
}

export interface Classification {
  decision: 'allow' | 'ask';
  reason: string;
  target?: { role: string; name: string };
}

function describe(n: SnapNode) {
  return { role: n.role, name: n.name };
}

export function classifyClick(snapshot: string, ref: string): Classification {
  const nodes = parseSnapshot(snapshot);
  const n = findByRef(nodes, ref);
  if (!n) return { decision: 'ask', reason: `Target "${ref}" not found in the latest snapshot` };
  const form = formContext(n);
  const sensitive = formIsSensitive(form);
  const name = n.name.trim();
  switch (n.role) {
    case 'link':
      if (DANGEROUS_LINK.test(name))
        return { decision: 'ask', reason: `Link "${name}" looks consequential`, target: describe(n) };
      return { decision: 'allow', reason: 'Following a link', target: describe(n) };
    case 'tab':
    case 'menuitem':
    case 'treeitem':
    case 'option':
    case 'textbox':
    case 'searchbox':
    case 'combobox':
    case 'heading':
    case 'img':
      return { decision: 'allow', reason: `Focusing/selecting a ${n.role}`, target: describe(n) };
    case 'checkbox':
    case 'radio':
    case 'switch':
      if (sensitive)
        return { decision: 'ask', reason: 'Toggling a control in a form with sensitive fields', target: describe(n) };
      return { decision: 'allow', reason: `Toggling a ${n.role}`, target: describe(n) };
    case 'button':
      if (!name) return { decision: 'ask', reason: 'Unnamed button — cannot tell what it does', target: describe(n) };
      if (SAFE_BUTTON.test(name)) return { decision: 'allow', reason: `Non-submitting button "${name}"`, target: describe(n) };
      if (SUBMIT_WORDS.test(name))
        return { decision: 'ask', reason: `Button "${name}" submits or commits an action`, target: describe(n) };
      if (form) return { decision: 'ask', reason: `Button "${name}" is inside a form`, target: describe(n) };
      return { decision: 'allow', reason: `Button "${name}" outside any form`, target: describe(n) };
    default:
      if (SUBMIT_WORDS.test(name) || SUBMIT_WORDS.test(n.text ?? ''))
        return { decision: 'ask', reason: `Element "${name || n.text}" looks like it submits`, target: describe(n) };
      if (sensitive) return { decision: 'ask', reason: 'Clicking inside a form with sensitive fields', target: describe(n) };
      return { decision: 'allow', reason: `Clicking a ${n.role || 'element'}`, target: describe(n) };
  }
}

export function classifyType(snapshot: string, ref: string, submit: boolean): Classification {
  const nodes = parseSnapshot(snapshot);
  const n = findByRef(nodes, ref);
  if (!n) return { decision: 'ask', reason: `Target "${ref}" not found in the latest snapshot` };
  if (n.role === 'searchbox' || /search/i.test(n.name))
    return { decision: 'allow', reason: 'Typing into a search box', target: describe(n) };
  if (isSensitiveField(n)) return { decision: 'ask', reason: `Typing into sensitive field "${n.name}"`, target: describe(n) };
  const form = formContext(n);
  if (formIsSensitive(form))
    return { decision: 'ask', reason: 'Typing into a form that contains password, email or payment fields', target: describe(n) };
  if (submit) return { decision: 'ask', reason: 'Typing and submitting a form', target: describe(n) };
  return { decision: 'allow', reason: `Typing into "${n.name || n.role}"`, target: describe(n) };
}

export function classifyFillForm(snapshot: string, refs: string[]): Classification {
  for (const ref of refs) {
    const c = classifyType(snapshot, ref, false);
    if (c.decision === 'ask') return c;
  }
  return { decision: 'allow', reason: 'Filling non-sensitive fields' };
}

export function classifyKey(snapshot: string, key: string): Classification {
  if (!/^(enter|return)$/i.test(key)) return { decision: 'allow', reason: `Pressing ${key}` };
  const nodes = parseSnapshot(snapshot);
  const active = [...walk(nodes)].find((n) => n.attrs.includes('active') && n.role !== 'generic');
  if (active && (active.role === 'searchbox' || /search/i.test(active.name)))
    return { decision: 'allow', reason: 'Submitting a search' };
  return { decision: 'ask', reason: 'Pressing Enter may submit a form' };
}

export interface HandoffSignal {
  kind: 'captcha' | 'sms' | 'login';
  evidence: string;
}

const CAPTCHA =
  /re-?captcha|h-?captcha|\bcaptcha\b|i'?m not a robot|verify (that )?you are (a )?human|are you (a )?(robot|human)|cloudflare.{0,40}(challenge|security|verif)|turnstile|press (&|and) hold|security check/i;
const SMS =
  /(code|text) (was |we )?sent to (your )?(phone|mobile|number|\+?\d)|verify (your )?phone( number)?|enter (the )?(\d-digit )?(sms|verification) code|we('ve| have)? (just )?texted/i;
const LOGIN_WALL = /(sign|log) ?in to (continue|view|see)|you (must|need to) (be )?(sign|log)(ged)? ?in/i;

/** Scan a snapshot for steps the agent must hand off to the human. */
export function detectHandoff(snapshot: string): HandoffSignal | undefined {
  const yaml = extractSnapshotYaml(snapshot);
  const lines = yaml.split('\n');
  const hit = (re: RegExp) => lines.find((l) => re.test(l));
  let l = hit(CAPTCHA);
  if (l) return { kind: 'captcha', evidence: l.trim() };
  l = hit(SMS);
  if (l) return { kind: 'sms', evidence: l.trim() };
  l = hit(LOGIN_WALL);
  if (l) return { kind: 'login', evidence: l.trim() };
  return undefined;
}

/** Heuristic: page text that addresses the agent directly (possible prompt injection). */
export function detectInjection(text: string): string | undefined {
  const m = text.match(
    /(ignore (all |any )?(previous|prior|above) instructions|(ai|llm|assistant|agent)s?,? (you must|please|should) |system prompt|install (this|the following) mcp|forward (all|every|your) (email|mail|inbox)|email (your|the) inbox to)/i,
  );
  return m ? m[0] : undefined;
}
