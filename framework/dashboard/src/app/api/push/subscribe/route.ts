import { NextRequest } from 'next/server';
import { saveSub } from '@/lib/push/webpush';

export const dynamic = 'force-dynamic';

// POST /api/push/subscribe {subscription, device} — stores this phone's push subscription (login required).
export async function POST(req: NextRequest) {
  let body: { subscription?: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }; device?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const s = body.subscription;
  if (!s || typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint) || typeof s.keys?.p256dh !== 'string' || typeof s.keys?.auth !== 'string') {
    return Response.json({ error: 'subscription with endpoint and keys is required' }, { status: 400 });
  }
  const device = typeof body.device === 'string' ? body.device.slice(0, 120) : 'unknown';
  saveSub({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } }, device);
  return Response.json({ ok: true });
}
