import { NextResponse } from 'next/server';
import { services } from '@/server/services';
import { getConfig } from '@/server/config';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const u = new URL(req.url);
  const name = u.searchParams.get('state') ?? '';
  const code = u.searchParams.get('code');
  const back = new URL('/', getConfig().appUrl);
  const s = services();
  const cfg = (await s.registry.activeMcp()).find((c) => c.name === name);
  if (!cfg || !code) {
    back.searchParams.set('error', 'Integration sign-in failed');
    return NextResponse.redirect(back);
  }
  try {
    // The PKCE verifier saved for this server binds the code to our request.
    await s.mcpAuth.finishOAuth(cfg, code);
    s.audit.write(null, 'integration_connected', { name });
    s.sessions.onIntegrationConnected(name);
    back.searchParams.set('connected', name);
  } catch (e) {
    back.searchParams.set('error', (e as Error).message);
  }
  return NextResponse.redirect(back);
}
