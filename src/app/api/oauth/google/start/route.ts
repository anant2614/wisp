import { NextResponse } from 'next/server';
import { services } from '@/server/services';
import { issueState } from '@/server/oauthState';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const account = new URL(req.url).searchParams.get('account');
  if (account !== 'personal' && account !== 'agent') return new Response('account must be personal or agent', { status: 400 });
  try {
    return NextResponse.redirect(services().google.authUrl(account, issueState(account)));
  } catch (e) {
    return new Response(String((e as Error).message), { status: 500 });
  }
}
