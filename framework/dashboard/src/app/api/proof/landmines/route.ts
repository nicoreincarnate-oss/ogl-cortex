import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { runLandmines } from '@/lib/glitch/sources';

export const dynamic = 'force-dynamic';

// Runs tools/landmines/run.sh (read-only tests) and stores the result with its time.
export async function POST() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return NextResponse.json(runLandmines());
}
