import { services } from '@/server/services';
import type { PoppetEvent } from '@/server/events';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ conv: string }> }) {
  const { conv } = await params;
  const s = services();
  const enc = new TextEncoder();
  let unsubscribe = () => {};
  let ping: NodeJS.Timeout | undefined;
  const stream = new ReadableStream({
    start(controller) {
      const send = (e: PoppetEvent | { type: 'hello'; running: boolean }) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          unsubscribe();
        }
      };
      send({ type: 'hello', running: s.sessions.isRunning(conv) });
      unsubscribe = s.bus.subscribe(conv, send);
      ping = setInterval(() => {
        try {
          controller.enqueue(enc.encode(': ping\n\n'));
        } catch {
          clearInterval(ping);
        }
      }, 15_000);
      req.signal.addEventListener('abort', () => {
        unsubscribe();
        clearInterval(ping);
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      unsubscribe();
      clearInterval(ping);
    },
  });
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' },
  });
}
