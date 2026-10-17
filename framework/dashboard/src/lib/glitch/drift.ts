// Done drift (AgentTrail idea, Glitch Cat "no theater" rule):
// a task marked done names its files; if those files change after it closed, the done is stale.
// Pure core (findDrift) takes a stat function so tests can drive it without a disk.

export interface DoneTask {
  id: string;
  title: string;
  assignee: string;
  org: string;
  completed_at: string;
  text: string; // description + result: where the task names its files
}

export interface PathStat {
  exists: boolean;
  mtimeMs: number; // newest write under this path
}

export interface DriftRow {
  task: DoneTask;
  path: string;
  kind: 'changed' | 'gone';
  changedAt?: string;
  minutesAfter?: number;
}

// Paths a task can name: repo-relative under these roots, ~/..., or /Users/...
const PATH_RE = /(?:~\/|\/Users\/|\b(?:deliverables|tools|src|dashboard|templates|bus|scripts|walks)\/)[^\s'"`<>|,;)\]]+/g;

// Files that change by design after any task closes: daily memory, logs, state and lock files.
const ALWAYS_MOVING = [/\.claude\.json$/, /\/memory\//, /^memory\//, /\.log$/, /\.jsonl$/, /\.lock$/, /state\.json$/, /\/state\//, /\.bak/];

export const GRACE_MS = 2 * 60 * 1000;

export function extractPaths(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(PATH_RE)) {
    const p = m[0].replace(/[.:]+$/, '');
    if (p.includes('*') || p.includes('{') || p.includes('$')) continue;
    if (ALWAYS_MOVING.some((r) => r.test(p))) continue;
    // a bare top folder (~/Clients, tools/) is too wide to say anything about one task
    if (p.replace(/^~\/|^\/Users\/[^/]+\//, '').replace(/\/$/, '').split('/').length < 2) continue;
    found.add(p);
  }
  return [...found];
}

export function findDrift(
  tasks: DoneTask[],
  resolve: (task: DoneTask, p: string) => string,
  stat: (absPath: string) => PathStat,
): DriftRow[] {
  const rows: DriftRow[] = [];
  for (const task of tasks) {
    const closed = Date.parse(task.completed_at);
    if (Number.isNaN(closed)) continue;
    for (const p of extractPaths(task.text)) {
      const s = stat(resolve(task, p));
      if (!s.exists) {
        rows.push({ task, path: p, kind: 'gone' });
      } else if (s.mtimeMs > closed + GRACE_MS) {
        rows.push({
          task,
          path: p,
          kind: 'changed',
          changedAt: new Date(s.mtimeMs).toISOString(),
          minutesAfter: Math.round((s.mtimeMs - closed) / 60000),
        });
      }
    }
  }
  return rows.sort((a, b) => Date.parse(b.task.completed_at) - Date.parse(a.task.completed_at));
}
