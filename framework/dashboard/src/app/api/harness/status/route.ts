import { readHarnessProjection } from '@/lib/data/harness';

export const dynamic = 'force-dynamic';

/**
 * GET /api/harness/status
 *
 * Auth is enforced by dashboard middleware. This route is deliberately GET
 * only and reads the sanitized projection file, never the harness control DB.
 */
export async function GET() {
  const snapshot = readHarnessProjection();
  const { projects, humanRequests, seats, ...status } = snapshot;

  return Response.json(
    {
      ...status,
      projectedProjectCount: projects.length,
      openHumanRequestCount: humanRequests.filter(
        (request) => request.status === 'open',
      ).length,
      rosterSeatCount: seats.length,
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
