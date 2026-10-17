import { vapidKeys } from '@/lib/push/webpush';

export const dynamic = 'force-dynamic';

// GET /api/push/key — the public VAPID key the phone needs to subscribe (login required).
export async function GET() {
  return Response.json({ publicKey: vapidKeys().publicKey });
}
