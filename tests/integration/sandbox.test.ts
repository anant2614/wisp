import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { DockerSandbox } from '@/server/sandbox';
import { tempHome } from '../helpers';

/** Runs against a real Docker daemon; skipped when none is available. */
const sandbox = new DockerSandbox(path.join(tempHome('poppet-sbx-'), 'scratch'), 'node:22-slim', 30_000);
const available = await sandbox.available();

describe.skipIf(!available)('Docker sandbox runner', () => {
  beforeAll(() => {
    process.env.HOST_ONLY_SECRET = 'host-env-must-not-leak';
  });

  it('runs tests and reports pass/fail', async () => {
    const code = 'export default async function run(i: { a: number }) { return i.a * 2; }';
    const ok = await sandbox.test({
      code,
      tests:
        "import test from 'node:test'; import assert from 'node:assert'; import run from './tool.ts';\ntest('x', async () => assert.equal(await run({ a: 2 }), 4));",
    });
    expect(ok.passed).toBe(true);
    const bad = await sandbox.test({
      code,
      tests:
        "import test from 'node:test'; import assert from 'node:assert'; import run from './tool.ts';\ntest('x', async () => assert.equal(await run({ a: 2 }), 5));",
    });
    expect(bad.passed).toBe(false);
    expect(bad.output).toMatch(/fail/i);
  });

  it('passes input and granted secrets only, redacts secrets from output, mounts nothing else', async () => {
    const code = `
      import fs from 'node:fs';
      export default async function run(input: { q: string }, ctx: { secrets: Record<string, string> }) {
        let hostFile = 'absent';
        try { fs.readFileSync('/host/etc/passwd'); hostFile = 'present'; } catch {}
        let writable = true;
        try { fs.writeFileSync('/usr/x', '1'); } catch { writable = false; }
        return {
          q: input.q,
          key: ctx.secrets.API_KEY,
          hostEnv: process.env.HOST_ONLY_SECRET ?? null,
          work: fs.readdirSync('/work').sort(),
          hostFile,
          rootWritable: writable,
          user: process.getuid?.(),
        };
      }`;
    const r = await sandbox.run({ code }, { q: 'hello' }, { API_KEY: 'sk-live-123456' });
    expect(r.ok).toBe(true);
    const out = r.output as Record<string, unknown>;
    expect(out.q).toBe('hello');
    expect(out.key).toBe('[secret]'); // received inside, redacted on the way out
    expect(out.hostEnv).toBeNull();
    expect(out.work).toEqual(['package.json', 'runner.mjs', 'tool.ts']);
    expect(out.hostFile).toBe('absent');
    expect(out.rootWritable).toBe(false);
    expect(out.user).not.toBe(0);
  });

  it('reports thrown errors and kills runaway code', async () => {
    const err = await sandbox.run({ code: 'export default async function run() { throw new Error("boom"); }' }, {});
    expect(err.ok).toBe(false);
    expect(err.error).toContain('boom');
    const slow = new DockerSandbox(path.join(tempHome('poppet-sbx-'), 'scratch'), 'node:22-slim', 3_000);
    const hang = await slow.run(
      { code: 'export default async function run() { await new Promise(() => setInterval(() => {}, 1000)); }' },
      {},
    );
    expect(hang.ok).toBe(false);
    expect(hang.error).toBe('Timed out');
  });
});
