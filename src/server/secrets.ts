import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Credential storage. Secrets never go to the model: tools read them here, and
 * the model only ever sees placeholders like {{secret:site:example.com}}.
 * v1 uses the macOS Keychain (keytar); v2 swaps in a KMS / vault.
 */
export interface SecretStore {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
  list(): Promise<string[]>;
}

const SERVICE = 'poppet';

export class MemorySecretStore implements SecretStore {
  private m = new Map<string, string>();
  async get(n: string) {
    return this.m.get(n);
  }
  async set(n: string, v: string) {
    this.m.set(n, v);
  }
  async delete(n: string) {
    this.m.delete(n);
  }
  async list() {
    return [...this.m.keys()];
  }
}

/** Fallback for non-macOS dev machines: a 0600 JSON file inside the workspace. */
export class FileSecretStore implements SecretStore {
  constructor(private file: string) {}
  private read(): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }
  private write(d: Record<string, string>) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(d, null, 2), { mode: 0o600 });
  }
  async get(n: string) {
    return this.read()[n];
  }
  async set(n: string, v: string) {
    const d = this.read();
    d[n] = v;
    this.write(d);
  }
  async delete(n: string) {
    const d = this.read();
    delete d[n];
    this.write(d);
  }
  async list() {
    return Object.keys(this.read());
  }
}

export class KeychainSecretStore implements SecretStore {
  private keytar: Promise<typeof import('keytar')>;
  constructor() {
    this.keytar = import('keytar').then((m) => (m as any).default ?? m);
  }
  async get(n: string) {
    return (await (await this.keytar).getPassword(SERVICE, n)) ?? undefined;
  }
  async set(n: string, v: string) {
    await (await this.keytar).setPassword(SERVICE, n, v);
  }
  async delete(n: string) {
    await (await this.keytar).deletePassword(SERVICE, n);
  }
  async list() {
    return (await (await this.keytar).findCredentials(SERVICE)).map((c) => c.account);
  }
}

export const SECRET_PLACEHOLDER = /\{\{secret:([^}]+)\}\}/g;

export function placeholder(name: string): string {
  return `{{secret:${name}}}`;
}

export function generatePassword(): string {
  // 20 chars from a URL-safe alphabet plus guaranteed character classes.
  const base = randomBytes(15).toString('base64url');
  return `${base}Aa1!`;
}

/** Replace {{secret:name}} placeholders anywhere in a JSON-like value. */
export async function substituteSecrets(
  value: unknown,
  store: SecretStore,
): Promise<{ value: unknown; used: Map<string, string> }> {
  const used = new Map<string, string>();
  const names = new Set<string>();
  JSON.stringify(value ?? null).replace(SECRET_PLACEHOLDER, (_, n) => {
    names.add(n);
    return '';
  });
  if (names.size === 0) return { value, used };
  for (const n of names) {
    const v = await store.get(n);
    if (v === undefined) throw new Error(`Unknown secret "${n}"`);
    used.set(n, v);
  }
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(SECRET_PLACEHOLDER, (_, n) => used.get(n) ?? _);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return { value: walk(value), used };
}

/** Replace any secret values back to placeholders before output reaches the model. */
export function redactSecrets<T>(value: T, used: Map<string, string>): T {
  if (used.size === 0) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      let s = v;
      for (const [n, secret] of used) {
        if (secret.length >= 4) s = s.split(secret).join(placeholder(n));
        // Playwright escapes quotes in generated code; also redact the JSON-escaped form.
        const escaped = JSON.stringify(secret).slice(1, -1);
        if (escaped !== secret && escaped.length >= 4) s = s.split(escaped).join(placeholder(n));
      }
      return s;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}
