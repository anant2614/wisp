import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { simpleGit, type SimpleGit } from 'simple-git';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from './db';
import { registryItems, secretGrants } from './db/schema';

export type RegistryKind = 'skill' | 'tool' | 'mcp';

export interface ToolManifest {
  name: string;
  description: string;
  /** JSON Schema (type: object) for the tool input. */
  inputSchema: Record<string, unknown>;
  /** Secret names the tool needs; each must be granted separately (FR-19). */
  secrets?: string[];
}

export type McpAuth =
  { type: 'none' } | { type: 'headers'; headers: { name: string; description?: string }[] } | { type: 'oauth' };

export interface McpConfig {
  name: string;
  /** The official registry entry this came from (required: only registry servers may be installed). */
  registryName: string;
  description?: string;
  transport: 'http' | 'stdio';
  url?: string;
  /** npm package spec run with npx, e.g. "@notionhq/notion-mcp-server@1.2.0". */
  package?: string;
  auth: McpAuth;
  /** Env var names (for stdio packages) whose values come from secrets. */
  env?: string[];
}

export interface SkillInfo {
  name: string;
  description: string;
  dir: string;
}

export interface RegistryItem {
  id: string;
  kind: RegistryKind;
  name: string;
  version: number;
  status: string;
  manifest: any;
  gitSha: string | null;
  failures: number;
  createdAt: number;
}

const NAME = /^[a-z][a-z0-9-]{1,48}$/;

export function assertName(name: string) {
  if (!NAME.test(name)) throw new Error(`Invalid name "${name}": use lowercase letters, digits and dashes`);
}

function safeRelPath(p: string) {
  const norm = path.posix.normalize(p.replace(/\\/g, '/'));
  if (norm.startsWith('..') || path.posix.isAbsolute(norm) || norm.includes('\0')) throw new Error(`Invalid file path "${p}"`);
  return norm;
}

/**
 * Stores skills, agent-written tools and MCP configs (FR-16..20). Active state
 * lives in a git repo so every change can be reviewed and rolled back; the
 * pending/ area is not tracked.
 */
export class Registry {
  readonly root: string;
  private git: SimpleGit;
  private ready: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private db: Db,
    root: string,
  ) {
    this.root = root;
    fs.mkdirSync(root, { recursive: true });
    this.git = simpleGit(root);
    this.ready = this.init();
  }

  private async init() {
    for (const d of ['skills', 'tools', 'pending/skills', 'pending/tools', 'pending/mcp'])
      fs.mkdirSync(path.join(/*turbopackIgnore: true*/ this.root, d), { recursive: true });
    if (!fs.existsSync(path.join(this.root, '.git'))) {
      await this.git.init();
      await this.git.addConfig('user.name', 'Poppet');
      await this.git.addConfig('user.email', 'poppet@localhost');
      await this.git.addConfig('commit.gpgsign', 'false');
      fs.writeFileSync(path.join(this.root, '.gitignore'), 'pending/\n');
      if (!fs.existsSync(this.mcpFile)) fs.writeFileSync(this.mcpFile, JSON.stringify({ servers: {} }, null, 2) + '\n');
      if (!fs.existsSync(this.disabledFile)) fs.writeFileSync(this.disabledFile, '[]\n');
      for (const d of ['skills', 'tools']) fs.writeFileSync(path.join(this.root, d, '.gitkeep'), '');
      await this.git.add('-A');
      await this.git.commit('Initialise Poppet registry');
    }
  }

  /** Serialise git operations. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(async () => {
      await this.ready;
      return fn();
    });
    this.queue = p.catch(() => {});
    return p;
  }

  get mcpFile() {
    return path.join(this.root, 'mcp.json');
  }
  private get disabledFile() {
    return path.join(this.root, 'disabled.json');
  }

  private activeDir(kind: RegistryKind, name: string) {
    return path.join(this.root, kind === 'skill' ? 'skills' : 'tools', name);
  }
  private pendingDir(kind: RegistryKind, name: string) {
    return path.join(this.root, 'pending', kind === 'skill' ? 'skills' : kind === 'tool' ? 'tools' : 'mcp', name);
  }

  private nextVersion(kind: RegistryKind, name: string) {
    const last = this.db
      .select()
      .from(registryItems)
      .where(and(eq(registryItems.kind, kind), eq(registryItems.name, name)))
      .orderBy(desc(registryItems.version))
      .get();
    return (last?.version ?? 0) + 1;
  }

  private insertItem(kind: RegistryKind, name: string, manifest: unknown): RegistryItem {
    const id = randomUUID();
    const version = this.nextVersion(kind, name);
    this.db
      .insert(registryItems)
      .values({ id, kind, name, version, status: 'pending', manifestJson: JSON.stringify(manifest), createdAt: Date.now() })
      .run();
    return this.get(id)!;
  }

  get(id: string): RegistryItem | undefined {
    const r = this.db.select().from(registryItems).where(eq(registryItems.id, id)).get();
    return r ? toItem(r) : undefined;
  }

  items(): RegistryItem[] {
    return this.db.select().from(registryItems).orderBy(desc(registryItems.createdAt)).all().map(toItem);
  }

  // ---------- proposals (pending area) ----------

  async proposeSkill(name: string, skillMd: string, files: Record<string, string> = {}) {
    assertName(name);
    if (!/^---\n[\s\S]*?description:/m.test(skillMd))
      throw new Error('SKILL.md must start with YAML frontmatter that includes a description');
    return this.run(async () => {
      const dir = this.pendingDir('skill', name);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const all: Record<string, string> = { 'SKILL.md': skillMd, ...files };
      for (const [rel, content] of Object.entries(all)) {
        const target = path.join(dir, safeRelPath(rel));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
      }
      const item = this.insertItem('skill', name, { name, files: Object.keys(all) });
      return { item, diff: diffDirs(this.activeDir('skill', name), dir) };
    });
  }

  async proposeTool(manifest: ToolManifest, code: string, tests: string, testResult: { passed: boolean; output: string }) {
    assertName(manifest.name);
    return this.run(async () => {
      const dir = this.pendingDir('tool', manifest.name);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
      fs.writeFileSync(path.join(dir, 'tool.ts'), code);
      fs.writeFileSync(path.join(dir, 'tool.test.ts'), tests);
      const item = this.insertItem('tool', manifest.name, { ...manifest, testResult });
      return { item, diff: diffDirs(this.activeDir('tool', manifest.name), dir) };
    });
  }

  async proposeMcp(cfg: McpConfig) {
    assertName(cfg.name);
    return this.run(async () => {
      fs.writeFileSync(this.pendingDir('mcp', cfg.name) + '.json', JSON.stringify(cfg, null, 2));
      const item = this.insertItem('mcp', cfg.name, cfg);
      return { item };
    });
  }

  // ---------- decisions ----------

  async approve(id: string): Promise<RegistryItem> {
    return this.run(async () => {
      const item = this.get(id);
      if (!item || item.status !== 'pending') throw new Error('No such pending registry item');
      if (item.kind === 'mcp') {
        const cfg = item.manifest as McpConfig;
        const mcp = this.readMcp();
        mcp.servers[cfg.name] = cfg;
        fs.writeFileSync(this.mcpFile, JSON.stringify(mcp, null, 2) + '\n');
        fs.rmSync(this.pendingDir('mcp', cfg.name) + '.json', { force: true });
      } else {
        const from = this.pendingDir(item.kind, item.name);
        const to = this.activeDir(item.kind, item.name);
        fs.rmSync(to, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.renameSync(from, to);
      }
      this.setDisabled(item.kind, item.name, false);
      await this.git.add('-A');
      const c = await this.git.commit(`Activate ${item.kind} ${item.name} v${item.version}`);
      const sha = c.commit || (await this.git.revparse(['HEAD'])).trim();
      this.db
        .update(registryItems)
        .set({ status: 'superseded' })
        .where(and(eq(registryItems.kind, item.kind), eq(registryItems.name, item.name), eq(registryItems.status, 'active')))
        .run();
      this.db.update(registryItems).set({ status: 'active', gitSha: sha, failures: 0 }).where(eq(registryItems.id, id)).run();
      return this.get(id)!;
    });
  }

  async reject(id: string): Promise<void> {
    return this.run(async () => {
      const item = this.get(id);
      if (!item || item.status !== 'pending') return;
      if (item.kind === 'mcp') fs.rmSync(this.pendingDir('mcp', item.name) + '.json', { force: true });
      else fs.rmSync(this.pendingDir(item.kind, item.name), { recursive: true, force: true });
      this.db.update(registryItems).set({ status: 'rejected' }).where(eq(registryItems.id, id)).run();
    });
  }

  async setEnabled(kind: RegistryKind, name: string, enabled: boolean): Promise<void> {
    return this.run(async () => {
      this.setDisabled(kind, name, !enabled);
      await this.git.add('-A');
      await this.git.commit(`${enabled ? 'Enable' : 'Disable'} ${kind} ${name}`);
      this.db
        .update(registryItems)
        .set({ status: enabled ? 'active' : 'disabled' })
        .where(
          and(
            eq(registryItems.kind, kind),
            eq(registryItems.name, name),
            eq(registryItems.status, enabled ? 'disabled' : 'active'),
          ),
        )
        .run();
      if (!enabled)
        this.db
          .update(registryItems)
          .set({ status: 'disabled' })
          .where(and(eq(registryItems.kind, kind), eq(registryItems.name, name), eq(registryItems.status, 'degraded')))
          .run();
    });
  }

  async remove(kind: RegistryKind, name: string): Promise<void> {
    return this.run(async () => {
      if (kind === 'mcp') {
        const mcp = this.readMcp();
        delete mcp.servers[name];
        fs.writeFileSync(this.mcpFile, JSON.stringify(mcp, null, 2) + '\n');
      } else fs.rmSync(this.activeDir(kind, name), { recursive: true, force: true });
      this.setDisabled(kind, name, false);
      await this.git.add('-A');
      await this.git.commit(`Delete ${kind} ${name}`);
      this.db
        .update(registryItems)
        .set({ status: 'deleted' })
        .where(and(eq(registryItems.kind, kind), eq(registryItems.name, name)))
        .run();
    });
  }

  /**
   * Roll an item back to the version that was active before the current one
   * (restoring its files from that activation's git commit), or remove it if
   * there is no earlier version. Repeated rollbacks keep stepping back.
   */
  async rollback(kind: RegistryKind, name: string): Promise<string> {
    return this.run(async () => {
      const rows = this.db
        .select()
        .from(registryItems)
        .where(and(eq(registryItems.kind, kind), eq(registryItems.name, name)))
        .orderBy(desc(registryItems.version))
        .all();
      const current = rows.find((r) => ['active', 'disabled', 'degraded'].includes(r.status));
      if (!current) throw new Error(`${kind} ${name} has no active version to roll back`);
      const prev = rows.find((r) => r.status === 'superseded' && r.version < current.version && r.gitSha);
      const rel = kind === 'mcp' ? 'mcp.json' : path.relative(this.root, this.activeDir(kind, name));
      if (kind === 'mcp') {
        const cur = this.readMcp();
        const prevCfg = prev ? JSON.parse(await this.git.show([`${prev.gitSha}:mcp.json`])).servers?.[name] : undefined;
        if (prevCfg) cur.servers[name] = prevCfg;
        else delete cur.servers[name];
        fs.writeFileSync(this.mcpFile, JSON.stringify(cur, null, 2) + '\n');
      } else {
        fs.rmSync(this.activeDir(kind, name), { recursive: true, force: true });
        if (prev) await this.git.raw(['checkout', prev.gitSha!, '--', rel]);
      }
      this.setDisabled(kind, name, false);
      await this.git.add('-A');
      const target = prev ? `v${prev.version}` : 'nothing';
      const c = await this.git.commit(`Roll back ${kind} ${name} v${current.version} → ${target}`);
      this.db.update(registryItems).set({ status: 'rolled_back' }).where(eq(registryItems.id, current.id)).run();
      if (prev) this.db.update(registryItems).set({ status: 'active' }).where(eq(registryItems.id, prev.id)).run();
      return c.commit;
    });
  }

  async history(limit = 50) {
    await this.ready;
    const l = await this.git.log({ maxCount: limit });
    return l.all.map((c) => ({ sha: c.hash, message: c.message, date: c.date }));
  }

  // ---------- runtime failure tracking ----------

  recordToolResult(name: string, ok: boolean): 'ok' | 'degraded' {
    const row = this.db
      .select()
      .from(registryItems)
      .where(and(eq(registryItems.kind, 'tool'), eq(registryItems.name, name), eq(registryItems.status, 'active')))
      .get();
    if (!row) return 'ok';
    const failures = ok ? 0 : row.failures + 1;
    const status = failures >= 3 ? 'degraded' : 'active';
    this.db.update(registryItems).set({ failures, status }).where(eq(registryItems.id, row.id)).run();
    return status === 'degraded' ? 'degraded' : 'ok';
  }

  // ---------- secret grants ----------

  grantSecret(toolName: string, secretName: string) {
    const item = this.db
      .select()
      .from(registryItems)
      .where(and(eq(registryItems.kind, 'tool'), eq(registryItems.name, toolName)))
      .orderBy(desc(registryItems.version))
      .get();
    if (!item) throw new Error(`No tool named ${toolName}`);
    this.db.insert(secretGrants).values({ id: randomUUID(), registryItemId: toolName, secretName, approvedAt: Date.now() }).run();
  }

  grantedSecrets(toolName: string): string[] {
    return this.db
      .select()
      .from(secretGrants)
      .where(eq(secretGrants.registryItemId, toolName))
      .all()
      .map((g) => g.secretName);
  }

  // ---------- reading active state ----------

  private readMcp(): { servers: Record<string, McpConfig> } {
    try {
      return JSON.parse(fs.readFileSync(this.mcpFile, 'utf8'));
    } catch {
      return { servers: {} };
    }
  }

  private readDisabled(): string[] {
    try {
      return JSON.parse(fs.readFileSync(this.disabledFile, 'utf8'));
    } catch {
      return [];
    }
  }

  private setDisabled(kind: RegistryKind, name: string, disabled: boolean) {
    const key = `${kind}:${name}`;
    const cur = new Set(this.readDisabled());
    if (disabled) cur.add(key);
    else cur.delete(key);
    fs.writeFileSync(this.disabledFile, JSON.stringify([...cur].sort(), null, 2) + '\n');
  }

  private isDegraded(kind: RegistryKind, name: string) {
    return Boolean(
      this.db
        .select()
        .from(registryItems)
        .where(and(eq(registryItems.kind, kind), eq(registryItems.name, name), eq(registryItems.status, 'degraded')))
        .get(),
    );
  }

  async activeSkills(): Promise<SkillInfo[]> {
    await this.ready;
    const disabled = new Set(this.readDisabled());
    const dir = path.join(this.root, 'skills');
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !disabled.has(`skill:${d.name}`))
      .flatMap((d) => {
        const file = path.join(dir, d.name, 'SKILL.md');
        if (!fs.existsSync(file)) return [];
        const md = fs.readFileSync(file, 'utf8');
        const desc = md.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '';
        return [{ name: d.name, description: desc, dir: path.join(dir, d.name) }];
      });
  }

  async readSkill(name: string): Promise<{ skillMd: string; files: string[] } | undefined> {
    const s = (await this.activeSkills()).find((x) => x.name === name);
    if (!s) return undefined;
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else files.push(path.relative(s.dir, p));
      }
    };
    walk(s.dir);
    return { skillMd: fs.readFileSync(path.join(s.dir, 'SKILL.md'), 'utf8'), files };
  }

  async activeTools(): Promise<{ manifest: ToolManifest; code: string; degraded: boolean }[]> {
    await this.ready;
    const disabled = new Set(this.readDisabled());
    const dir = path.join(this.root, 'tools');
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !disabled.has(`tool:${d.name}`))
      .flatMap((d) => {
        try {
          const manifest = JSON.parse(fs.readFileSync(path.join(dir, d.name, 'manifest.json'), 'utf8')) as ToolManifest;
          const code = fs.readFileSync(path.join(dir, d.name, 'tool.ts'), 'utf8');
          return [{ manifest, code, degraded: this.isDegraded('tool', d.name) }];
        } catch {
          return [];
        }
      });
  }

  async activeMcp(): Promise<McpConfig[]> {
    await this.ready;
    const disabled = new Set(this.readDisabled());
    return Object.values(this.readMcp().servers).filter((c) => !disabled.has(`mcp:${c.name}`));
  }

  /** Source of an active or pending item, for the Settings "view source" panel. */
  source(kind: RegistryKind, name: string): Record<string, string> {
    if (kind === 'mcp') {
      const cfg = this.readMcp().servers[name];
      return cfg ? { 'mcp.json': JSON.stringify(cfg, null, 2) } : {};
    }
    const out: Record<string, string> = {};
    for (const base of [this.activeDir(kind, name), this.pendingDir(kind, name)]) {
      if (!fs.existsSync(base)) continue;
      const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else out[path.relative(this.root, p)] = fs.readFileSync(p, 'utf8');
        }
      };
      walk(base);
    }
    return out;
  }
}

function toItem(r: typeof registryItems.$inferSelect): RegistryItem {
  return {
    id: r.id,
    kind: r.kind as RegistryKind,
    name: r.name,
    version: r.version,
    status: r.status,
    manifest: JSON.parse(r.manifestJson),
    gitSha: r.gitSha,
    failures: r.failures,
    createdAt: r.createdAt,
  };
}

/** A small unified-style diff of two directories (new files show in full). */
export function diffDirs(oldDir: string, newDir: string): string {
  const read = (d: string) => {
    const out = new Map<string, string>();
    if (!fs.existsSync(d)) return out;
    const walk = (x: string) => {
      for (const e of fs.readdirSync(x, { withFileTypes: true })) {
        const p = path.join(x, e.name);
        if (e.isDirectory()) walk(p);
        else out.set(path.relative(d, p), fs.readFileSync(p, 'utf8'));
      }
    };
    walk(d);
    return out;
  };
  const a = read(oldDir);
  const b = read(newDir);
  const names = [...new Set([...a.keys(), ...b.keys()])].sort();
  const parts: string[] = [];
  for (const n of names) {
    const x = a.get(n);
    const y = b.get(n);
    if (x === y) continue;
    parts.push(`--- ${x === undefined ? '/dev/null' : 'a/' + n}\n+++ ${y === undefined ? '/dev/null' : 'b/' + n}`);
    parts.push(lineDiff(x ?? '', y ?? ''));
  }
  return parts.join('\n') || '(no changes)';
}

function lineDiff(a: string, b: string): string {
  const A = a ? a.split('\n') : [];
  const B = b ? b.split('\n') : [];
  // LCS table (inputs are small: skill and tool files).
  const dp = Array.from({ length: A.length + 1 }, () => new Array<number>(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--)
    for (let j = B.length - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) {
      out.push(' ' + A[i]);
      i++;
      j++;
    } else if (j < B.length && (i >= A.length || dp[i][j + 1] >= dp[i + 1][j])) out.push('+' + B[j++]);
    else out.push('-' + A[i++]);
  }
  return out.join('\n');
}
