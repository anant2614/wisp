import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { simpleGit } from 'simple-git';
import { openDb } from '@/server/db';
import { Registry, diffDirs } from '@/server/registry';
import { tempHome } from '../helpers';

const skill = (desc: string) => `---\nname: lead-search\ndescription: ${desc}\n---\n\nSteps...\n`;

describe('registry state changes', () => {
  let reg: Registry;
  let root: string;
  beforeEach(() => {
    root = path.join(tempHome('poppet-reg-'), 'registry');
    reg = new Registry(openDb(':memory:'), root);
  });

  it('pending → active (git commit) → disabled → enabled', async () => {
    const { item, diff } = await reg.proposeSkill('lead-search', skill('Find leads'), { 'scripts/x.md': 'hi' });
    expect(item.status).toBe('pending');
    expect(diff).toContain('+description: Find leads');
    expect(fs.existsSync(path.join(root, 'pending/skills/lead-search/SKILL.md'))).toBe(true);
    expect(await reg.activeSkills()).toEqual([]);

    const active = await reg.approve(item.id);
    expect(active.status).toBe('active');
    expect(active.gitSha).toMatch(/^[0-9a-f]{7,40}$/);
    expect((await reg.activeSkills()).map((s) => s.description)).toEqual(['Find leads']);
    expect(fs.existsSync(path.join(root, 'pending/skills/lead-search'))).toBe(false);
    expect((await reg.history())[0].message).toBe('Activate skill lead-search v1');

    await reg.setEnabled('skill', 'lead-search', false);
    expect(await reg.activeSkills()).toEqual([]);
    expect(reg.get(item.id)!.status).toBe('disabled');
    await reg.setEnabled('skill', 'lead-search', true);
    expect((await reg.activeSkills()).length).toBe(1);
    expect(reg.get(item.id)!.status).toBe('active');
  });

  it('rolls back to the previous version, then to nothing', async () => {
    await reg.approve((await reg.proposeSkill('lead-search', skill('v1'))).item.id);
    const v2 = await reg.proposeSkill('lead-search', skill('v2'));
    expect(v2.item.version).toBe(2);
    expect(v2.diff).toContain('-description: v1');
    expect(v2.diff).toContain('+description: v2');
    await reg.approve(v2.item.id);
    expect((await reg.activeSkills())[0].description).toBe('v2');

    await reg.rollback('skill', 'lead-search');
    expect((await reg.activeSkills())[0].description).toBe('v1');
    expect(reg.get(v2.item.id)!.status).toBe('rolled_back');
    expect(reg.items().find((i) => i.version === 1)!.status).toBe('active');

    await reg.rollback('skill', 'lead-search');
    expect(await reg.activeSkills()).toEqual([]);
    const log = await simpleGit(root).log();
    expect(log.all.filter((c) => c.message.startsWith('Roll back'))).toHaveLength(2);
  });

  it('rejects proposals and leaves nothing behind', async () => {
    const { item } = await reg.proposeSkill('lead-search', skill('x'));
    await reg.reject(item.id);
    expect(reg.get(item.id)!.status).toBe('rejected');
    expect(fs.existsSync(path.join(root, 'pending/skills/lead-search'))).toBe(false);
    await expect(reg.approve(item.id)).rejects.toThrow();
  });

  it('validates names, frontmatter and file paths', async () => {
    await expect(reg.proposeSkill('../evil', skill('x'))).rejects.toThrow('Invalid name');
    await expect(reg.proposeSkill('ok-name', 'no frontmatter')).rejects.toThrow('frontmatter');
    await expect(reg.proposeSkill('ok-name', skill('x'), { '../../etc/passwd': 'x' })).rejects.toThrow('Invalid file path');
  });

  it('manages MCP configs in mcp.json and tool degradation', async () => {
    const { item } = await reg.proposeMcp({
      name: 'notion',
      registryName: 'io.example/notion',
      transport: 'http',
      url: 'https://mcp.example/notion',
      auth: { type: 'oauth' },
    });
    await reg.approve(item.id);
    expect((await reg.activeMcp()).map((m) => m.name)).toEqual(['notion']);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'mcp.json'), 'utf8')).servers.notion.url).toBe(
      'https://mcp.example/notion',
    );
    await reg.remove('mcp', 'notion');
    expect(await reg.activeMcp()).toEqual([]);

    const t = await reg.proposeTool(
      { name: 'wc', description: 'count', inputSchema: { type: 'object' } },
      'export default async () => 1',
      '',
      { passed: true, output: 'ok' },
    );
    await reg.approve(t.item.id);
    expect(reg.recordToolResult('wc', false)).toBe('ok');
    expect(reg.recordToolResult('wc', false)).toBe('ok');
    expect(reg.recordToolResult('wc', false)).toBe('degraded');
    expect((await reg.activeTools())[0].degraded).toBe(true);
  });

  it('diffs directories', () => {
    const a = path.join(tempHome(), 'a');
    const b = path.join(tempHome(), 'b');
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    fs.writeFileSync(path.join(a, 'f.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(b, 'f.txt'), 'one\nthree\n');
    fs.writeFileSync(path.join(b, 'g.txt'), 'new');
    const d = diffDirs(a, b);
    expect(d).toContain('-two');
    expect(d).toContain('+three');
    expect(d).toContain('--- /dev/null\n+++ b/g.txt');
  });
});
