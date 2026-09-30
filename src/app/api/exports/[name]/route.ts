import { services } from '@/server/services';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ name: string }> }) {
  const name = decodeURIComponent((await params).name);
  const content = services().exports.read(name);
  if (content === undefined) return new Response('Not found', { status: 404 });
  const download = new URL(req.url).searchParams.has('download');
  return new Response(content, {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      ...(download ? { 'content-disposition': `attachment; filename="${name.replace(/"/g, '')}"` } : {}),
    },
  });
}
