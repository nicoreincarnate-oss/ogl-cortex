// The Team page: what each switched-on seat is for, what it is doing, what it finished today.
import fs from 'fs';
import path from 'path';
import { CTX_ROOT, getAgentDir, getEnabledAgents } from '@/lib/config';
import { defaultOrg } from '@/lib/install';
import { startOfToday } from '@/components/proof/when';
import { plainFor, fillMissing } from './plain';

// Each seat's name and job in plain words, written by hand in CTX_ROOT/config/team.json as
// { "<seat>": { "label": "...", "job": "..." } }; its key order is the page order. A seat missing
// there shows the first line of the Role section of its IDENTITY.md.
function readJobs(): Record<string, { label: string; job: string }> {
  try {
    return JSON.parse(fs.readFileSync(path.join(CTX_ROOT, 'config', 'team.json'), 'utf8'));
  } catch {
    return {};
  }
}

function roleLine(name: string): string {
  try {
    const text = fs.readFileSync(path.join(getAgentDir(name, defaultOrg()), 'IDENTITY.md'), 'utf8');
    return text.match(/^## Role\s*\n+([^\n#<][^\n]*)/m)?.[1].trim() ?? '';
  } catch {
    return '';
  }
}

export interface TeamTask { id: string; title: string; plain: string | null; at: string }
export interface Seat {
  name: string;
  label: string;
  job: string;
  heartbeatAgeMin: number | null;
  now: TeamTask[];
  doneToday: TeamTask[];
  stuck: number;
}


export function team(): { seats: Seat[]; readAt: string } {
  const JOBS = readJobs();
  const on = getEnabledAgents() ?? new Set(Object.keys(JOBS));
  const since = startOfToday();
  const bySeat = new Map<string, { now: TeamTask[]; done: TeamTask[]; stuck: number }>();
  for (const n of on) bySeat.set(n, { now: [], done: [], stuck: 0 });

  const all: { id: string; title: string }[] = [];
  const orgsDir = path.join(CTX_ROOT, 'orgs');
  for (const org of fs.readdirSync(orgsDir)) {
    const dir = path.join(orgsDir, org, 'tasks');
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      let t: Record<string, string>;
      try {
        t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      } catch {
        continue;
      }
      const seat = bySeat.get(t.assigned_to ?? t.assignee ?? '');
      if (!seat) continue;
      const row = (at: string): TeamTask => ({ id: t.id, title: t.title, plain: plainFor(t.id, t.title), at });
      if (t.status === 'in_progress') {
        seat.now.push(row(t.updated_at ?? t.created_at));
        all.push({ id: t.id, title: t.title });
      } else if (t.status === 'completed' && t.completed_at && Date.parse(t.completed_at) >= since) {
        seat.done.push(row(t.completed_at));
        all.push({ id: t.id, title: t.title });
      } else if (t.status === 'blocked' && Date.parse(t.updated_at ?? t.created_at) >= Date.now() - 14 * 864e5) {
        // Blocked with no activity in 14 days is backlog, not "waiting on someone"
        seat.stuck++;
      }
    }
  }
  fillMissing(all);

  const seats: Seat[] = [...bySeat.entries()].map(([name, s]) => {
    let heartbeatAgeMin: number | null = null;
    try {
      const hb = JSON.parse(fs.readFileSync(path.join(CTX_ROOT, 'state', name, 'heartbeat.json'), 'utf8'));
      heartbeatAgeMin = Math.round((Date.now() - Date.parse(hb.last_heartbeat)) / 60000);
    } catch {
      /* no heartbeat file: shown as unknown, not as healthy */
    }
    const newest = (a: TeamTask, b: TeamTask) => Date.parse(b.at) - Date.parse(a.at);
    return {
      name,
      label: JOBS[name]?.label ?? name,
      job: JOBS[name]?.job ?? (roleLine(name) || 'No job line written yet.'),
      heartbeatAgeMin,
      now: s.now.sort(newest),
      doneToday: s.done.sort(newest),
      stuck: s.stuck,
    };
  });
  const order = Object.keys(JOBS);
  seats.sort((a, b) => (order.indexOf(a.name) + 99) % 99 - (order.indexOf(b.name) + 99) % 99);
  return { seats, readAt: new Date().toISOString() };
}
