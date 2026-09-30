import { randomBytes } from 'node:crypto';

const g = globalThis as unknown as { __poppetOauth?: Map<string, { value: string; exp: number }> };
const states = (g.__poppetOauth ??= new Map());

/** One-time OAuth `state` values (CSRF protection for the callback). */
export function issueState(value: string): string {
  const nonce = randomBytes(16).toString('hex');
  states.set(nonce, { value, exp: Date.now() + 15 * 60_000 });
  return nonce;
}

export function consumeState(nonce: string | null): string | undefined {
  if (!nonce) return undefined;
  const s = states.get(nonce);
  states.delete(nonce);
  return s && s.exp > Date.now() ? s.value : undefined;
}
