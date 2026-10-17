import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { resolveClientFile } from '@/lib/data/clients';

export const dynamic = 'force-dynamic';

const TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

// GET /api/clients/file?path=<path inside ~/Clients> — opens one client file (read-only, login required).
// HTML is sent as a download, never rendered, so a file cannot run script on this site.
export async function GET(req: NextRequest) {
  const abs = resolveClientFile(req.nextUrl.searchParams.get('path') ?? '');
  if (!abs) return Response.json({ error: 'Not found' }, { status: 404 });
  const ext = path.extname(abs).toLowerCase();
  const type = TYPES[ext];
  const name = encodeURIComponent(path.basename(abs));
  return new Response(fs.readFileSync(abs), {
    headers: {
      'Content-Type': type ?? 'application/octet-stream',
      'Content-Disposition': `${type ? 'inline' : 'attachment'}; filename*=UTF-8''${name}`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
