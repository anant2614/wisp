import { NextResponse } from 'next/server';
import { services } from '@/server/services';
import { consumeState } from '@/server/oauthState';
import { getConfig } from '@/server/config';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const u = new URL(req.url);
  const account = consumeState(u.searchParams.get('state'));
  const code = u.searchParams.get('code');
  const back = new URL('/settings', getConfig().appUrl);
  if (!account || !code) {
    back.searchParams.set('error', u.searchParams.get('error') ?? 'Google sign-in failed (bad state)');
    return NextResponse.redirect(back);
  }
  try {
    const email = await services().google.exchangeCode(account as 'personal' | 'agent', code);
    services().audit.write(null, 'account_connected', { provider: 'google', account, email });
    back.searchParams.set('connected', `google:${account}`);
  } catch (e) {
    back.searchParams.set('error', (e as Error).message);
  }
  return NextResponse.redirect(back);
}
