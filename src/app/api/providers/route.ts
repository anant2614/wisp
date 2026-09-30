import { services } from '@/server/services';
import { body, guard, json } from '@/server/http';
import { engineFor, MODEL_OPTIONS, PROVIDERS, SECRET_KEYS, type Provider } from '@/server/providers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = services();
  const current = s.providers.current();
  return json({
    current,
    engine: engineFor(current),
    models: MODEL_OPTIONS[engineFor(current)],
    statuses: await s.providers.status(),
    canImportCodexLogin: s.providers.canImportCodexLogin(),
    chatgptLogin: s.providers.loginState(),
    claudeTokenSaved: Boolean(await s.secrets.get(SECRET_KEYS.claudeOauthToken)),
  });
}

const SECRET_ACTIONS: Record<string, string> = {
  set_anthropic_key: SECRET_KEYS.anthropicApiKey,
  set_claude_token: SECRET_KEYS.claudeOauthToken,
  set_openai_key: SECRET_KEYS.openaiApiKey,
};

/**
 * POST { action, ... }:
 *   select {provider} · set_anthropic_key / set_claude_token / set_openai_key {value} (empty clears)
 *   chatgpt_login → {url} · chatgpt_import · chatgpt_logout
 */
export async function POST(req: Request) {
  const bad = guard(req);
  if (bad) return bad;
  const b = await body<{ action?: string; provider?: Provider; value?: string }>(req);
  const s = services();
  try {
    if (b.action === 'select') {
      if (!b.provider || !PROVIDERS.includes(b.provider)) return json({ error: 'unknown provider' }, 400);
      s.providers.select(b.provider);
      s.audit.write(null, 'provider_selected', { provider: b.provider });
      return json({ ok: true });
    }
    if (b.action && SECRET_ACTIONS[b.action]) {
      const key = SECRET_ACTIONS[b.action];
      const value = b.value?.trim();
      if (value) await s.secrets.set(key, value);
      else await s.secrets.delete(key);
      s.audit.write(null, value ? 'provider_credential_saved' : 'provider_credential_cleared', { key });
      return json({ ok: true });
    }
    if (b.action === 'chatgpt_login') return json({ url: await s.providers.startChatGptLogin() });
    if (b.action === 'chatgpt_import') {
      s.providers.importCodexLogin();
      s.audit.write(null, 'provider_credential_saved', { key: 'codex:auth.json', source: 'import' });
      return json({ ok: true });
    }
    if (b.action === 'chatgpt_logout') {
      s.providers.signOutChatGpt();
      s.audit.write(null, 'provider_credential_cleared', { key: 'codex:auth.json' });
      return json({ ok: true });
    }
    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}
