// CRM v1: every company we work with or chase, built only from records we already keep.
//   Clients + prospects: client folders under CTX_CLIENTS_ROOT (lib/data/clients.ts)
//   Grader leads: an optional lead watch state file (CTX_LEAD_WATCH_FILE), each lead sent to CTX_LEAD_RECIPIENT
//   People: the Persons section of the memory seat's ENTITIES.md, matched to a company by name
// Read-only. Every row says where it came from.
import fs from 'fs';
import path from 'path';
import { CRM_EXCLUDE, CRM_OWN, LEAD_RECIPIENT, LEAD_WATCH_FILE, memorySeat, seatDir } from '@/lib/install';
import { getClientFolders } from '@/lib/data/clients';

export type Stage = 'Client' | 'Prospect' | 'Lead';

export interface CrmPerson {
  name: string;
  match: string;
  roleMatch: string;
  note: string;
  emails: string[];
  phones: string[];
}

export interface CrmCompany {
  name: string;
  stage: Stage;
  lastTouch: string | null;
  source: string;
  detail: string;
  files: number;
  people: CrmPerson[];
  keys: string[];
}

// Friends and family in ENTITIES.md are not CRM contacts (CTX_CRM_EXCLUDE).
const isPersonal = (name: string) => CRM_EXCLUDE.some((n) => name.toLowerCase().startsWith(n));
// Our own addresses are not theirs (CTX_CRM_OWN).
const isOwn = (addr: string) => CRM_OWN.some((o) => addr.toLowerCase() === o || addr.toLowerCase().endsWith(o.startsWith('@') ? o : `@${o}`));
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Words that name a company in other records: every word of 4+ letters, or an acronym like OGL.
export function keysFor(name: string): string[] {
  return name
    .split(/[\s.]+/)
    .filter((w) => (w.length >= 4 && !/^(hotel|projects|church|the|solar|com|org|net)$/i.test(w)) || /^[A-Z]{3,}$/.test(w))
    .map((w) => w.toLowerCase());
}

// Who someone is, in one plain line: the first clause of their entry, minus asides and markup.
function roleLine(rest: string): string {
  let t = rest;
  for (let i = 0; i < 3; i++) t = t.replace(/\([^()]*\)/g, '').replace(/\[[^\[\]]*\]/g, '');
  t = t.replace(/\*\*/g, '').replace(/`[^`]*`/g, '').replace(/^[\s—-]+/, '');
  const clause = t.split(/;|\. |—/)[0].replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim().replace(/[,.]$/, '');
  if (clause.length <= 90) return clause;
  return clause.slice(0, 90).replace(/\s+\S*$/, '') + '…';
}

function readPeople(): CrmPerson[] {
  try {
    const seat = memorySeat();
    if (!seat) return [];
    const text = fs.readFileSync(path.join(seatDir(seat), 'ENTITIES.md'), 'utf8');
    const start = text.indexOf('## Persons');
    const end = text.indexOf('## Companies', start);
    const section = text.slice(start, end > start ? end : undefined);
    const people: CrmPerson[] = [];
    for (const line of section.split('\n')) {
      const m = line.match(/^- \*\*(.+?)\*\*\s*(.*)$/);
      if (!m || isPersonal(m[1])) continue;
      const rest = m[2].replace(/^[—-]\s*/, '');
      if (/competitor/i.test(rest.slice(0, 600))) continue; // a rival, not a contact
      people.push({
        name: m[1].replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s*\/.*$/, '').trim(),
        match: m[1].toLowerCase(),
        roleMatch: roleLine(rest).toLowerCase(),
        note: roleLine(rest),
        // Contacts from the head of the entry only: later text quotes other people's addresses.
        emails: [...new Set(rest.slice(0, 600).match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? [])].map((e) => e.replace(/[.,;)]+$/, '')).filter((e) => !isOwn(e)),
        phones: [...new Set(rest.slice(0, 600).match(/\+\d[\d\s-]{8,}\d/g) ?? [])],
      });
    }
    // An address that also sits in someone else's entry belongs to whoever lists it first in their own line.
    const owner = new Map<string, { who: string; at: number }>();
    for (const line of section.split('\n')) {
      const m = line.match(/^- \*\*(.+?)\*\*/);
      if (!m) continue;
      for (const hit of line.matchAll(/[\w.+-]+@[\w-]+\.[\w.]+|\+\d[\d\s-]{8,}\d/g)) {
        const key = hit[0].replace(/[.,;)]+$/, '');
        const prev = owner.get(key);
        if (!prev || (hit.index ?? 0) < prev.at) owner.set(key, { who: m[1], at: hit.index ?? 0 });
      }
    }
    for (const p of people) {
      const clean = (n: string) => n.replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s*\/.*$/, '').trim();
      const mine = (x: string) => !owner.has(x) || clean(owner.get(x)!.who) === p.name;
      p.emails = p.emails.filter(mine);
      p.phones = p.phones.filter(mine);
    }
    return people;
  } catch {
    return [];
  }
}

// The lead watch writes its processed list by hand, in several shapes (plain lines and JSON objects).
// A lead is an entry that went to the lead recipient; team demos, own-domain and calibration scans are not leads.
const DOMAIN_RE = /\b((?:[a-z0-9-]+\.)+(?:com|org|net|ai|sh|law|io|co|us|mx|biz|info))\b/gi;
const NOT_LEADS = /^(google\.com|facebook\.com|wikipedia\.com|gmail\.com)$/i;

function readGraderLeads(): CrmCompany[] {
  try {
    if (!LEAD_WATCH_FILE || !LEAD_RECIPIENT) return [];
    const st = JSON.parse(fs.readFileSync(LEAD_WATCH_FILE, 'utf8'));
    const who = escapeRe(LEAD_RECIPIENT);
    const sentRe = new RegExp(`email(?:ed)?[^.]{0,40}${who}|"sent":"${who}`, 'i');
    const byDomain = new Map<string, CrmCompany>();
    for (const raw of (st.processed ?? []) as unknown[]) {
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
      const sent = sentRe.test(text) && !/TEAM DEMO/.test(text);
      if (!sent) continue;
      const head = text.split('->')[0];
      const domains = [...new Set((head.match(DOMAIN_RE) ?? []).map((d) => d.toLowerCase()))].filter((d) => !NOT_LEADS.test(d) && !CRM_OWN.includes(d));
      // One line can name two domains, each with its own score: take the score written right after the domain.
      const scoreFor = (d: string) =>
        text.match(new RegExp(d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^/]{0,40}?\\b(\\d{1,3})\\/100', 'i'))?.[1] ??
        text.match(/"score":(\d{1,3})/)?.[1];
      const date = text.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
      const caveat = text.match(/caveat[":\s]*([^)"]{0,120})/i)?.[1]?.trim();
      for (const d of domains) {
        const prev = byDomain.get(d);
        if (prev && (prev.lastTouch ?? '') >= (date ?? '')) continue;
        byDomain.set(d, {
          name: d,
          stage: 'Lead',
          lastTouch: date,
          source: `AEO grader scan, sent to ${LEAD_RECIPIENT}`,
          detail: `${scoreFor(d) ? `Scored ${scoreFor(d)}/100 on the grader. ` : ''}Lead sheet emailed to ${LEAD_RECIPIENT}.${caveat ? ` Note: ${caveat}` : ''}`,
          files: 0,
          people: [],
          keys: [d],
        });
      }
    }
    return [...byDomain.values()];
  } catch {
    return [];
  }
}

export function getCrm(): { companies: CrmCompany[]; counts: Record<Stage, number>; error?: string } {
  const { clients, prospects, error } = getClientFolders();
  const people = readPeople();
  const companyKeys = [...clients, ...prospects].map((c) => ({ name: c.client, keys: keysFor(c.client) }));
  const fromFolders = (stage: Stage) => (c: (typeof clients)[number]): CrmCompany => {
    const keys = keysFor(c.client);
    return {
      name: c.client,
      stage,
      lastTouch: c.latest,
      source: `client folder ${c.folder}`,
      detail: c.projects.slice(0, 3).map((p) => p.name).join(' · '),
      files: c.files.length,
      people: people.filter((p) => {
        // A company named in the person's own name line, e.g. "Justin (Cheers San Diego)", wins outright.
        const home = companyKeys.filter((ck) => ck.keys.some((k) => p.match.includes(k)));
        if (home.length > 0) return home.some((ck) => ck.name === c.client);
        return keys.some((k) => p.roleMatch.includes(k));
      }),
      keys,
    };
  };
  const companies = [
    ...clients.map(fromFolders('Client')),
    ...prospects.map(fromFolders('Prospect')),
    ...readGraderLeads(),
  ];
  const order: Record<Stage, number> = { Client: 0, Prospect: 1, Lead: 2 };
  companies.sort((a, b) => order[a.stage] - order[b.stage] || (b.lastTouch ?? '').localeCompare(a.lastTouch ?? ''));
  const counts = { Client: 0, Prospect: 0, Lead: 0 } as Record<Stage, number>;
  for (const c of companies) counts[c.stage]++;
  return { companies, counts, error };
}
