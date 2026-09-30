import { NextResponse } from 'next/server';
import { services } from '@/server/services';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Starts (or restarts) OAuth sign-in for an installed integration. */
export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const s = services();
  const cfg = (await s.registry.activeMcp()).find((c) => c.name === name);
  if (!cfg || cfg.auth.type !== 'oauth') return new Response('No OAuth integration by that name', { status: 404 });
  const url = await s.mcpAuth.beginOAuth(cfg);
  if (!url) {
    s.sessions.onIntegrationConnected(name);
    return NextResponse.redirect(new URL('/settings?connected=' + encodeURIComponent(name), _req.url));
  }
  return NextResponse.redirect(url);
}
