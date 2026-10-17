import fs from 'fs';
import path from 'path';
import { IG_CONVEYOR_DIR, IG_DIR_PATTERN } from '@/lib/data/ig-calendar';

export const dynamic = 'force-dynamic';

/**
 * GET /api/ig-calendar/cover/:dir
 *
 * Auth is enforced by dashboard middleware. Serves only out/<NN-id>/cover.jpg;
 * the pattern check keeps the path inside the conveyor folder.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ dir: string }> },
) {
  const { dir } = await params;
  if (!IG_DIR_PATTERN.test(dir)) return new Response('bad dir', { status: 400 });
  if (!IG_CONVEYOR_DIR) return new Response('not found', { status: 404 });
  const file = path.join(IG_CONVEYOR_DIR, 'out', dir, 'cover.jpg');
  if (!fs.existsSync(file)) return new Response('not found', { status: 404 });
  return new Response(fs.readFileSync(file), {
    headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' },
  });
}
