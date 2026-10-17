import { NextRequest } from 'next/server';
import { getCrm } from '@/lib/data/crm';
import { addNote, setDone } from '@/lib/data/crm-notes';

export const dynamic = 'force-dynamic';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// POST /api/crm/notes {company, text, followUp?}  adds a note (login required by middleware)
// PATCH /api/crm/notes {company, id, done}         marks a follow-up done or open
export async function POST(req: NextRequest) {
  let body: { company?: unknown; text?: unknown; followUp?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const company = typeof body.company === 'string' ? body.company : '';
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const followUp = typeof body.followUp === 'string' && DAY.test(body.followUp) ? body.followUp : null;
  if (!getCrm().companies.some((c) => c.name === company)) return Response.json({ error: 'Unknown company' }, { status: 400 });
  if (!text || text.length > 2000) return Response.json({ error: 'Note must be 1-2000 characters' }, { status: 400 });
  return Response.json({ note: addNote(company, text, followUp) });
}

export async function PATCH(req: NextRequest) {
  let body: { company?: unknown; id?: unknown; done?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (typeof body.company !== 'string' || typeof body.id !== 'string' || typeof body.done !== 'boolean') {
    return Response.json({ error: 'company, id and done are required' }, { status: 400 });
  }
  return setDone(body.company, body.id, body.done) ? Response.json({ ok: true }) : Response.json({ error: 'Not found' }, { status: 404 });
}
