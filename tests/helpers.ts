import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { FakeModel } from './fixtures/fakeModel';

export function tempHome(prefix = 'poppet-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export async function startFakeModel(model = new FakeModel()) {
  const server = http.createServer((req, res) => {
    model.handle(req, res, req.url ?? '/').catch((e) => {
      res.writeHead(500);
      res.end(String(e));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { model, url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

/** Configure env for an in-process Poppet (no browser, memory secrets). */
export function testEnv(home: string, extra: Record<string, string> = {}) {
  Object.assign(process.env, {
    POPPET_HOME: home,
    POPPET_SECRETS: 'memory',
    POPPET_BROWSER: 'off',
    POPPET_SANDBOX: 'disabled',
    POPPET_ANTHROPIC_API_KEY: 'sk-test',
    POPPET_INBOX_POLL_MS: '100',
    ...extra,
  });
}

export async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 30_000, what = 'condition'): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
}
