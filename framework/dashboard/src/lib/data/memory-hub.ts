// What the memory is about, for a person: kinds of note, people and companies, and the corrections ledger.
// Built on lib/data/memory-stores.ts (where the files are). Read-only.
import fs from 'fs';
import path from 'path';
import { CTX_ROOT } from '@/lib/config';
import { defaultOrg, memorySeat, seatDir } from '@/lib/install';
import { listStore, type MemFile } from '@/lib/data/memory-stores';

/** What a memory file is, in a word a person would use. */
export function kindOf(f: Pick<MemFile, 'store' | 'rel'>): string {
  const top = f.rel.split(path.sep)[0];
  if (f.store.startsWith('lessons:')) return 'Lesson';
  if (f.store === 'blueprint') return 'Blueprint';
  if (f.store.startsWith('seat:')) {
    if (/^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(f.rel)) return 'Daily log';
    if (f.rel.startsWith('memory/handoffs/')) return 'Handoff';
    if (f.rel === 'MEMORY.md') return 'Long-term memory';
    if (f.rel === 'ENTITIES.md') return 'People index';
    if (f.rel === 'STATE.md') return 'Checkpoint';
    if (f.rel.startsWith('memory/topics/')) return 'Topic notes';
    return 'Agent note';
  }
  if (top === '05 Sessions') return 'Session';
  if (/^(03 Projects|30 Projects|projects)$/.test(top)) return 'Project';
  if (/^(04 People|people)$/.test(top)) return 'Person';
  if (top === 'companies') return 'Company';
  return 'Brain note';
}

/** Order kinds appear in grouped search results: things about the world first, then the agents' own notes. */
export const KIND_ORDER = ['Person', 'Company', 'Project', 'Lesson', 'Checkpoint', 'Long-term memory', 'People index', 'Topic notes', 'Session', 'Brain note', 'Daily log', 'Handoff', 'Agent note', 'Blueprint'];

export interface Entity {
  name: string;
  kind: 'Person' | 'Company';
  line: string; // who or what they are, one plain line
  entry: string; // the full ENTITIES.md entry, markdown
  notes: MemFile[]; // brain notes named for them
}

// Who someone is, in one plain line: the first clause of their entry, minus asides and markup.
function firstClause(rest: string): string {
  let t = rest;
  for (let i = 0; i < 3; i++) t = t.replace(/\([^()]*\)/g, '').replace(/\[[^[\]]*\]/g, '');
  t = t.replace(/\*\*/g, '').replace(/`[^`]*`/g, '').replace(/^[\s—-]+/, '');
  const clause = t.split(/;|\. |—/)[0].replace(/\s+/g, ' ').trim().replace(/[,.]$/, '');
  return clause.length <= 100 ? clause : clause.slice(0, 100).replace(/\s+\S*$/, '') + '…';
}

const cleanName = (n: string) => n.replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s*\/.*$/, '').trim();

/** People and companies: the memory seat's ENTITIES.md index (CTX_MEMORY_SEAT), joined to the brain's person and company notes. */
export function getEntities(): Entity[] {
  const out = new Map<string, Entity>();
  try {
    const seat = memorySeat();
    if (!seat) throw new Error('no memory seat');
    const text = fs.readFileSync(path.join(seatDir(seat), 'ENTITIES.md'), 'utf8');
    let kind: Entity['kind'] | null = null;
    for (const line of text.split('\n')) {
      if (line.startsWith('## ')) kind = /^## Persons/.test(line) ? 'Person' : /^## Companies/.test(line) ? 'Company' : null;
      const m = line.match(/^- \*\*(.+?)\*\*\s*(.*)$/);
      if (!kind || !m) continue;
      const name = cleanName(m[1]);
      out.set(name.toLowerCase(), { name, kind, line: firstClause(m[2].replace(/^[—-]\s*/, '')), entry: line.slice(2), notes: [] });
    }
  } catch {
    // no index: the brain notes below still list
  }
  for (const f of listStore('brain')) {
    const k = kindOf(f);
    if (k !== 'Person' && k !== 'Company') continue;
    const key = f.title.toLowerCase();
    const hit = out.get(key) ?? [...out.values()].find((e) => key.includes(e.name.toLowerCase()) || e.name.toLowerCase().includes(key));
    if (hit) hit.notes.push(f);
    else out.set(key, { name: f.title, kind: k, line: '', entry: '', notes: [f] });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface Correction {
  at: string;
  agent: string;
  by: string;
  claim: string;
  correction: string;
}

let corrCache: { at: number; rows: Correction[] } | null = null;

/** The corrections ledger: every truth_correction event any agent logged, newest first. Cached 2 minutes. */
export function getCorrections(): Correction[] {
  if (corrCache && Date.now() - corrCache.at < 120_000) return corrCache.rows;
  const dir = path.join(CTX_ROOT, 'orgs', defaultOrg(), 'analytics', 'events');
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name.endsWith('.jsonl')) files.push(abs);
    }
  };
  const rows: Correction[] = [];
  try {
    walk(dir);
    for (const f of files) {
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        if (!line.includes('"event":"truth_correction"')) continue;
        try {
          const r = JSON.parse(line);
          const m = r.metadata ?? {};
          rows.push({
            at: m.occurred_at ?? r.timestamp,
            agent: m.caught_agent ?? r.agent,
            by: m.caught_by ?? m.corrected_by ?? '',
            claim: String(m.claim ?? m.what ?? ''),
            correction: String(m.correction ?? m.correct ?? ''),
          });
        } catch {
          // a torn line: skip it
        }
      }
    }
  } catch {
    // no ledger folder: an empty list, shown as such
  }
  rows.sort((a, b) => b.at.localeCompare(a.at));
  corrCache = { at: Date.now(), rows };
  return rows;
}

/** The "where the work stands" lines from the memory seat's STATE.md checkpoint. */
export function checkpointLines(): { current: string; next: string } {
  try {
    const seat = memorySeat();
    if (!seat) return { current: '', next: '' };
    const s = fs.readFileSync(path.join(seatDir(seat), 'STATE.md'), 'utf8');
    return {
      current: s.match(/^CURRENT CHECKPOINT(?: \([^)]*\))?:\s*(.+)$/m)?.[1] ?? '',
      next: s.match(/^EXACT NEXT STEP:\s*(.+)$/m)?.[1] ?? '',
    };
  } catch {
    return { current: '', next: '' };
  }
}
