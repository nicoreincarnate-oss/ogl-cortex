import { sendPush } from '@/lib/push/webpush';

export const dynamic = 'force-dynamic';

// POST /api/push/test — sends one test alert to every subscribed device (login required).
export async function POST() {
  return Response.json(await sendPush({ title: 'Cortex OS', body: 'Alerts are on. This is what they look like.', url: '/approvals', tag: 'test' }));
}
