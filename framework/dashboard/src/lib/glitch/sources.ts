// Server-side readers for the Proof pages. Each returns what it read and when, or an error it does not hide:
// a reader that fails says so on the page (Glitch Cat: a non-reading is never shown as a reading).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { CTX_FRAMEWORK_ROOT, CTX_ROOT } from '@/lib/config';
import { defaultOrg, memorySeat, seatDir } from '@/lib/install';
import { findDrift, type DoneTask, type PathStat } from './drift';

// The proof tools (fleet-truth, landmines, calendar) live in the memory seat's tools/ folder (CTX_MEMORY_SEAT).
// When a tool is not there, its reader says so on the page.
const toolsSeat = () => seatDir(memorySeat());

export interface Read<T> {
  data: T | null;
  readAt: string;
  source: string;
  error?: string;
}

function read<T>(source: string, fn: () => T): Read<T> {
  const readAt = new Date().toISOString();
  try {
    return { data: fn(), readAt, source };
  } catch (e) {
    return { data: null, readAt, source, error: e instanceof Error ? e.message.slice(0, 400) : String(e) };
  }
}

// ---- Fleet truth -------------------------------------------------------------
export interface SeatTruth {
  seat: string;
  verdict: 'consistent' | 'silent-but-alive' | 'claimed-not-evidenced' | 'dark' | string;
  heartbeat_age_h: number | null;
  transcript_age_h: number | null;
  last_event_age_h: number | null;
  last_event: string | null;
  claim: string | null;
}

export function fleetTruth(): Read<SeatTruth[]> {
  const script = path.join(toolsSeat(), 'tools', 'fleet-truth', 'fleet_truth.py');
  return read(script, () => JSON.parse(execFileSync('python3', [script, '--json'], { encoding: 'utf8', timeout: 30000 })));
}

// ---- Done drift ----------------------------------------------------------------
function newestMtime(p: string, depth = 3, budget = { n: 3000 }): number {
  const st = fs.statSync(p);
  if (!st.isDirectory() || depth === 0) return st.mtimeMs;
  let newest = st.mtimeMs;
  for (const name of fs.readdirSync(p)) {
    if (budget.n-- <= 0) break;
    if (name === 'node_modules' || name === '.git' || name === '.next') continue;
    try {
      newest = Math.max(newest, newestMtime(path.join(p, name), depth - 1, budget));
    } catch {
      /* unreadable entry: skip it, the rest still counts */
    }
  }
  return newest;
}

export function statPath(abs: string): PathStat {
  try {
    return { exists: true, mtimeMs: newestMtime(abs) };
  } catch {
    return { exists: false, mtimeMs: 0 };
  }
}

export function resolveTaskPath(task: DoneTask, p: string): string {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  if (p.startsWith('/')) return p;
  // Seats name each other's files by their own relative paths: try the assignee first, then the other seats.
  const agentsDir = path.join(CTX_FRAMEWORK_ROOT, 'orgs', task.org, 'agents');
  const own = path.join(agentsDir, task.assignee || memorySeat(), p);
  if (fs.existsSync(own)) return own;
  try {
    for (const seat of fs.readdirSync(agentsDir)) {
      const other = path.join(agentsDir, seat, p);
      if (fs.existsSync(other)) return other;
    }
  } catch {
    /* no agents dir: fall through to the assignee path */
  }
  return own;
}

export function doneTasks(days: number): DoneTask[] {
  const since = Date.now() - days * 86400000;
  const out: DoneTask[] = [];
  const orgsDir = path.join(CTX_ROOT, 'orgs');
  for (const org of fs.readdirSync(orgsDir)) {
    const dir = path.join(orgsDir, org, 'tasks');
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (t.status !== 'completed' || !t.completed_at || Date.parse(t.completed_at) < since) continue;
        out.push({
          id: t.id, title: t.title, org,
          assignee: t.assigned_to ?? t.assignee ?? '',
          completed_at: t.completed_at,
          text: `${t.description ?? ''}\n${t.result ?? ''}`,
        });
      } catch {
        /* a half-written task file is skipped, not guessed at */
      }
    }
  }
  return out;
}

export function doneDrift(days = 7) {
  return read(`${CTX_ROOT}/orgs/*/tasks (completed, last ${days} days)`, () => {
    const tasks = doneTasks(days);
    const rows = findDrift(tasks, resolveTaskPath, statPath);
    const withPaths = tasks.filter((t) => /(?:deliverables|tools|src|dashboard|~\/|\/Users\/)/.test(t.text)).length;
    return { checked: tasks.length, withPaths, rows };
  });
}

// ---- Landmines -----------------------------------------------------------------
export interface Landmine { id: string; date: string; bug: string; rule: string; test: string }

export function landmines() {
  const file = path.join(toolsSeat(), 'tools', 'landmines', 'LANDMINES.md');
  return read(file, () => {
    const rows: Landmine[] = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const c = line.split('|').map((s) => s.trim());
      if (c.length >= 7 && /^L\d+$/.test(c[1])) rows.push({ id: c[1], date: c[2], bug: c[3], rule: c[4], test: c[5] });
    }
    return rows;
  });
}

export const LANDMINE_RUN = path.join(CTX_ROOT, 'dashboard', 'landmines-last-run.json');

export function lastLandmineRun(): { ranAt: string; exit: number; lines: string[] } | null {
  try {
    return JSON.parse(fs.readFileSync(LANDMINE_RUN, 'utf8'));
  } catch {
    return null;
  }
}

export function runLandmines() {
  const script = path.join(toolsSeat(), 'tools', 'landmines', 'run.sh');
  let exit = 0;
  let out = '';
  try {
    out = execFileSync('bash', [script], { encoding: 'utf8', timeout: 240000, cwd: toolsSeat() });
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    exit = err.status ?? 1;
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  const result = { ranAt: new Date().toISOString(), exit, lines: out.split('\n').filter((l) => /^(PASS|FAIL)/.test(l)) };
  fs.mkdirSync(path.dirname(LANDMINE_RUN), { recursive: true });
  fs.writeFileSync(LANDMINE_RUN, JSON.stringify(result, null, 1));
  return result;
}

// ---- Receipts ------------------------------------------------------------------
export interface ReceiptLine { agent: string; day: string; line: string; path: string; exists: boolean | null }

export function receipts(days = 3) {
  const agentsDir = path.join(CTX_FRAMEWORK_ROOT, 'orgs', defaultOrg(), 'agents');
  return read(`${agentsDir}/*/memory/<last ${days} days>.md`, () => {
    const out: ReceiptLine[] = [];
    const dayNames = Array.from({ length: days }, (_, i) => new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
    for (const agent of fs.readdirSync(agentsDir)) {
      for (const day of dayNames) {
        const f = path.join(agentsDir, agent, 'memory', `${day}.md`);
        if (!fs.existsSync(f)) continue;
        for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
          const m = line.match(/receipts?:\s*([^\s,;)]+)/i);
          if (!m) continue;
          const p = m[1].replace(/[.:]+$/, '');
          const abs = p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p.startsWith('/') ? p : path.join(agentsDir, agent, p);
          // a receipt that is an id (msg id, sha) cannot be opened here: shown as such, never as passed
          out.push({ agent, day, line: line.slice(0, 400), path: p, exists: p.includes('/') ? fs.existsSync(abs) : null });
        }
      }
    }
    return out.reverse();
  });
}

// ---- Calendar (read-only, from the calendar tool) -----------------------------------
export interface CalEvent { account: string; title: string; start: string; end: string; all_day: boolean; meet?: string; link?: string; where?: string; people: number }
export interface CalRead { read_at: string; accounts: { account: string; ok: boolean; count?: number; error?: string }[]; events: CalEvent[] }

let calCache: { at: number; value: Read<CalRead> } | null = null;

export function calendar(): Read<CalRead> {
  if (calCache && Date.now() - calCache.at < 5 * 60000) return calCache.value;
  const script = path.join(toolsSeat(), 'tools', 'ogl-dashboard', 'calendar_json.py');
  const value = read(script, () => JSON.parse(execFileSync('python3', [script, '7'], { encoding: 'utf8', timeout: 45000 })) as CalRead);
  if (!value.error) calCache = { at: Date.now(), value };
  return value;
}
