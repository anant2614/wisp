import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { getConfig } from './config';

export interface SandboxFiles {
  /** TypeScript tool module: `export default async function run(input, ctx) { ... }` */
  code: string;
  /** node:test test file importing "./tool.ts". */
  tests?: string;
}

export interface SandboxRunResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  logs: string;
  durationMs: number;
}

export interface SandboxTestResult {
  passed: boolean;
  output: string;
  durationMs: number;
}

/**
 * Runs untrusted, agent-written code. The interface is the v2 seam (E2B,
 * Vercel Sandbox, ...). Secrets are passed per call, only when granted.
 */
export interface Sandbox {
  available(): Promise<boolean>;
  test(files: SandboxFiles): Promise<SandboxTestResult>;
  run(files: SandboxFiles, input: unknown, secrets?: Record<string, string>): Promise<SandboxRunResult>;
}

const RUNNER = `
import run from './tool.ts';
let raw = '';
for await (const c of process.stdin) raw += c;
const secrets = {};
for (const [k, v] of Object.entries(process.env)) if (k.startsWith('POPPET_SECRET_')) secrets[k.slice(14)] = v;
try {
  const out = await run(JSON.parse(raw || '{}'), { secrets });
  process.stdout.write('\\n@@POPPET_RESULT@@' + JSON.stringify({ ok: true, output: out ?? null }));
} catch (e) {
  process.stdout.write('\\n@@POPPET_RESULT@@' + JSON.stringify({ ok: false, error: String(e && e.stack || e) }));
}
`;

export class DockerSandbox implements Sandbox {
  constructor(
    private scratchRoot: string,
    private image = getConfig().sandbox.image,
    private timeoutMs = getConfig().sandbox.timeoutMs,
  ) {}

  async available(): Promise<boolean> {
    const r = await exec('docker', ['info', '--format', '{{.ServerVersion}}'], '', 10_000);
    return r.code === 0;
  }

  private prepare(files: SandboxFiles): string {
    const dir = path.join(this.scratchRoot, randomUUID());
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'tool.ts'), files.code);
    if (files.tests) fs.writeFileSync(path.join(dir, 'tool.test.ts'), files.tests);
    fs.writeFileSync(path.join(dir, 'runner.mjs'), RUNNER);
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
    return dir;
  }

  private dockerArgs(dir: string, env: Record<string, string>, cmd: string[]): string[] {
    const args = [
      'run',
      '--rm',
      '-i',
      '--name',
      containerName(dir),
      '--network',
      'bridge',
      '--memory',
      '512m',
      '--cpus',
      '1',
      '--pids-limit',
      '256',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,size=64m',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--user',
      'node',
      // The only host mount: this call's scratch folder.
      '-v',
      `${dir}:/work`,
      '-w',
      '/work',
    ];
    for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
    return [...args, this.image, ...cmd];
  }

  async test(files: SandboxFiles): Promise<SandboxTestResult> {
    if (!files.tests) return { passed: false, output: 'No tests were provided.', durationMs: 0 };
    const dir = this.prepare(files);
    const t0 = Date.now();
    try {
      const r = await exec(
        'docker',
        this.dockerArgs(dir, {}, ['node', '--experimental-strip-types', '--no-warnings', '--test', 'tool.test.ts']),
        '',
        this.timeoutMs,
      );
      return { passed: r.code === 0, output: (r.stdout + r.stderr).slice(-8000), durationMs: Date.now() - t0 };
    } finally {
      await cleanup(dir);
    }
  }

  async run(files: SandboxFiles, input: unknown, secrets: Record<string, string> = {}): Promise<SandboxRunResult> {
    const dir = this.prepare(files);
    const t0 = Date.now();
    const env = Object.fromEntries(
      Object.entries(secrets).map(([k, v]) => [`POPPET_SECRET_${k.replace(/[^A-Za-z0-9_]/g, '_')}`, v]),
    );
    try {
      const r = await exec(
        'docker',
        this.dockerArgs(dir, env, ['node', '--experimental-strip-types', '--no-warnings', 'runner.mjs']),
        JSON.stringify(input ?? {}),
        this.timeoutMs,
      );
      const idx = r.stdout.lastIndexOf('@@POPPET_RESULT@@');
      const logs = (idx >= 0 ? r.stdout.slice(0, idx) : r.stdout) + r.stderr;
      if (idx < 0)
        return { ok: false, error: r.timedOut ? 'Timed out' : `Exited with code ${r.code}`, logs: logs.slice(-4000), durationMs: Date.now() - t0 };
      const parsed = JSON.parse(r.stdout.slice(idx + '@@POPPET_RESULT@@'.length));
      let out = { ...parsed, logs: logs.slice(-4000), durationMs: Date.now() - t0 } as SandboxRunResult;
      // Never echo granted secrets back out of the sandbox.
      for (const v of Object.values(secrets)) if (v.length >= 4) out = JSON.parse(JSON.stringify(out).split(v).join('[secret]'));
      return out;
    } finally {
      await cleanup(dir);
    }
  }
}

export class DisabledSandbox implements Sandbox {
  async available() {
    return false;
  }
  async test(): Promise<SandboxTestResult> {
    return { passed: false, output: 'The sandbox is disabled (POPPET_SANDBOX=disabled).', durationMs: 0 };
  }
  async run(): Promise<SandboxRunResult> {
    return { ok: false, error: 'The sandbox is disabled.', logs: '', durationMs: 0 };
  }
}

function containerName(dir: string) {
  return 'poppet-sbx-' + path.basename(dir);
}

async function cleanup(dir: string) {
  // A timed-out client leaves the container running; remove it by name.
  await exec('docker', ['rm', '-f', containerName(dir)], '', 15_000);
  fs.rmSync(dir, { recursive: true, force: true });
}

function exec(cmd: string, args: string[], stdin: string, timeoutMs: number) {
  return new Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill('SIGKILL');
    }, timeoutMs);
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + String(e), timedOut });
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
    p.stdin.end(stdin);
  });
}
