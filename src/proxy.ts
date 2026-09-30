import { NextResponse, type NextRequest } from 'next/server';

/**
 * Poppet is a local, single-user app. Refuse requests whose Host is not this
 * machine (or the configured app URL), which blocks DNS-rebinding pages from
 * reading conversations or approving actions.
 */
export function proxy(request: NextRequest) {
  const host = (request.headers.get('host') ?? '').toLowerCase();
  const hostname = host.replace(/:\d+$/, '');
  const allowed = new Set(['localhost', '127.0.0.1', '[::1]']);
  try {
    if (process.env.POPPET_APP_URL) allowed.add(new URL(process.env.POPPET_APP_URL).hostname.toLowerCase());
  } catch {}
  for (const h of (process.env.POPPET_ALLOWED_HOSTS ?? '').split(',')) if (h.trim()) allowed.add(h.trim().toLowerCase());
  if (!allowed.has(hostname)) return new NextResponse('Forbidden host', { status: 403 });
  return NextResponse.next();
}
