import fs from 'fs';
import path from 'path';
import { IG_ACCOUNT, IG_CONVEYOR_DIR } from '@/lib/install';

// Read-only view of an Instagram carousel conveyor (CTX_IG_CONVEYOR_DIR): schedule.json (planned slots),
// posted.jsonl (what actually went out, written by post_carousel.py) and each caption.
export { IG_CONVEYOR_DIR };

export const IG_DIR_PATTERN = /^\d{2}-[A-Za-z0-9_-]+$/;

export type IgPostStatus = 'posted' | 'scheduled' | 'overdue';

export interface IgCalendarPost {
  n: number;
  dir: string;
  at: string;
  status: IgPostStatus;
  caption: string;
  permalink: string | null;
  postedAt: string | null;
  theme: 'dark' | 'light';
}

export interface IgCalendarSnapshot {
  account: string;
  posts: IgCalendarPost[];
  error: string | null;
}

function readPosted(): Map<string, { permalink: string | null; at: string }> {
  const out = new Map<string, { permalink: string | null; at: string }>();
  const file = path.join(IG_CONVEYOR_DIR, 'poster/posted.jsonl');
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      out.set(rec.dir, { permalink: rec.permalink ?? null, at: rec.at });
    } catch {
      // a half-written line is skipped; the next read picks it up
    }
  }
  return out;
}

export function readIgCalendar(): IgCalendarSnapshot {
  const account = IG_ACCOUNT;
  if (!IG_CONVEYOR_DIR) return { account, posts: [], error: 'CTX_IG_CONVEYOR_DIR is not set' };
  try {
    const schedule: { n: number; dir: string; at: string }[] = JSON.parse(
      fs.readFileSync(path.join(IG_CONVEYOR_DIR, 'poster/schedule.json'), 'utf8'),
    );
    const posted = readPosted();
    const now = Date.now();
    const posts = schedule
      .filter((s) => IG_DIR_PATTERN.test(s.dir))
      .map((s): IgCalendarPost => {
        const p = posted.get(s.dir);
        const capFile = path.join(IG_CONVEYOR_DIR, 'out', s.dir, 'caption.txt');
        return {
          n: s.n,
          dir: s.dir,
          at: s.at,
          status: p ? 'posted' : Date.parse(s.at) < now ? 'overdue' : 'scheduled',
          caption: fs.existsSync(capFile) ? fs.readFileSync(capFile, 'utf8').trim() : '',
          permalink: p?.permalink ?? null,
          postedAt: p?.at ?? null,
          theme: s.n % 2 ? 'dark' : 'light',
        };
      });
    return { account, posts, error: null };
  } catch (e) {
    return { account, posts: [], error: e instanceof Error ? e.message : String(e) };
  }
}
