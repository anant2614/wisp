import { services } from '@/server/services';
import { json } from '@/server/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return json({ entries: services().audit.recent(300) });
}
