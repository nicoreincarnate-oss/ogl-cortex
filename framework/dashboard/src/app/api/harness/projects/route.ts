import { NextRequest } from 'next/server';
import { readHarnessProjection } from '@/lib/data/harness';

export const dynamic = 'force-dynamic';

/**
 * GET /api/harness/projects?org=<org>
 *
 * Auth is enforced by dashboard middleware. No mutation verbs are exported.
 */
export async function GET(request: NextRequest) {
  const org = request.nextUrl.searchParams.get('org');
  const snapshot = readHarnessProjection();
  const projects = org
    ? snapshot.projects.filter(
        (project) => project.org === null || project.org === org,
      )
    : snapshot.projects;

  return Response.json(
    {
      available: snapshot.available,
      state: snapshot.state,
      generatedAtMs: snapshot.generatedAtMs,
      sequence: snapshot.sequence,
      projects,
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
