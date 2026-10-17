// CRM notes and follow-ups, one list per company, kept in CTX_ROOT/state/crm/notes.json.
// The dashboard writes here when the operator adds a note; agents may read it. Atomic write: temp file + rename.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CTX_ROOT } from '@/lib/config';

export interface CrmNote {
  id: string;
  at: string;
  text: string;
  followUp: string | null;
  done: boolean;
}

const FILE = path.join(CTX_ROOT, 'state', 'crm', 'notes.json');

export function readNotes(): Record<string, CrmNote[]> {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

function write(all: Record<string, CrmNote[]>) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

export function addNote(company: string, text: string, followUp: string | null): CrmNote {
  const all = readNotes();
  const note: CrmNote = { id: crypto.randomBytes(6).toString('hex'), at: new Date().toISOString(), text, followUp, done: false };
  all[company] = [note, ...(all[company] ?? [])];
  write(all);
  return note;
}

export function setDone(company: string, id: string, done: boolean): boolean {
  const all = readNotes();
  const note = (all[company] ?? []).find((n) => n.id === id);
  if (!note) return false;
  note.done = done;
  write(all);
  return true;
}

/** Open follow-ups due on or before `day` (YYYY-MM-DD), oldest first. */
export function dueFollowUps(day: string): { company: string; note: CrmNote }[] {
  const out: { company: string; note: CrmNote }[] = [];
  for (const [company, notes] of Object.entries(readNotes())) {
    for (const note of notes) if (note.followUp && !note.done && note.followUp <= day) out.push({ company, note });
  }
  return out.sort((a, b) => (a.note.followUp ?? '').localeCompare(b.note.followUp ?? ''));
}
