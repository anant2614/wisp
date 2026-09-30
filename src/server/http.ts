import { NextResponse } from 'next/server';

/**
 * Mutating endpoints require a custom header (which forces a CORS preflight a
 * foreign site cannot pass) and a same-origin Origin header when present, so
 * another website open in the user's browser cannot approve actions.
 */
export function guard(req: Request): NextResponse | undefined {
  if (req.headers.get('x-poppet') !== '1') return NextResponse.json({ error: 'missing x-poppet header' }, { status: 403 });
  const origin = req.headers.get('origin');
  if (origin) {
    const host = req.headers.get('host');
    try {
      if (new URL(origin).host !== host) return NextResponse.json({ error: 'cross-origin request refused' }, { status: 403 });
    } catch {
      return NextResponse.json({ error: 'bad origin' }, { status: 403 });
    }
  }
  return undefined;
}

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export async function body<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}
