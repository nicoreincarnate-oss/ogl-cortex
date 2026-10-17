// Our memory itself, as stored on this machine (the files, not the architecture doc).
//   brain:   the vault (CTX_VAULT_PATH), the human-readable mirror of GBrain
//   seat:*   each live agent's MEMORY.md, ENTITIES.md, STATE.md and memory/ folder
//   lessons:* the saved lessons (Claude Code auto-memory) per agent
//   blueprint: the ogl-cortex repo, which describes how the memory works
// Read-only. Backups, archives and snapshots are left out: they repeat the live files.
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { CTX_ROOT } from '@/lib/config';
import { VAULT, lessonsDir, memorySeats, seatDir } from '@/lib/install';
import { MIRROR } from '@/lib/data/ogl-cortex';

export interface Store {
  id: string;
  label: string;
  group: 'brain' | 'seat' | 'lessons' | 'blueprint';
  root: string;
  // Top-level entries to include; undefined = everything under root.
  only?: string[];
}

const SEATS = memorySeats();
export { VAULT };

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const STORES: Store[] = [
  ...(VAULT ? [{ id: 'brain', label: 'Brain (vault)', group: 'brain', root: VAULT } as Store] : []),
  ...SEATS.map((s): Store => ({
    id: `seat:${s}`,
    label: cap(s),
    group: 'seat',
    root: seatDir(s),
    only: ['MEMORY.md', 'ENTITIES.md', 'STATE.md', 'USER.md', 'learnings.md', 'memory'],
  })),
  ...SEATS.map((s): Store => ({
    id: `lessons:${s}`,
    label: `${cap(s)}'s lessons`,
    group: 'lessons',
    root: lessonsDir(seatDir(s)),
  })).filter((s) => fs.existsSync(s.root)),
  { id: 'blueprint', label: 'How it works (ogl-cortex)', group: 'blueprint', root: MIRROR },
];

export const storeById = (id: string) => STORES.find((s) => s.id === id);

const SKIP_DIRS = new Set(['archive', 'backups', 'memorymd-snapshots', 'checkpoints', 'node_modules', 'graphify-out']);
const SKIP_FILE = /backup|predream/i;

/** True for a path (relative to its store) that is live memory, not a copy. */
export function included(store: Store, rel: string): boolean {
  const parts = rel.split(path.sep);
  if (store.only && !store.only.includes(parts[0])) return false;
  if (parts.some((p) => p.startsWith('.') && store.group !== 'blueprint')) return false;
  if (parts.includes('.git')) return false;
  // The vault's archive/ holds real notes; elsewhere archive/ holds copies of live files.
  if (parts.slice(0, -1).some((p) => SKIP_DIRS.has(p) && !(store.group === 'brain' && p === 'archive'))) return false;
  // A lessons folder's MEMORY.md is its index, not a lesson.
  if (store.group === 'lessons' && rel === 'MEMORY.md') return false;
  return rel.endsWith('.md') && !SKIP_FILE.test(parts[parts.length - 1]);
}

export interface MemFile {
  store: string;
  rel: string;
  title: string;
  mtimeMs: number;
  bytes: number;
}

function walk(store: Store, dir: string, out: MemFile[]) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const abs = path.join(dir, e.name);
    const rel = path.relative(store.root, abs);
    if (e.isDirectory()) {
      if (store.only && dir === store.root && !store.only.includes(e.name)) continue;
      walk(store, abs, out);
    } else if (e.isFile() && included(store, rel)) {
      const st = fs.statSync(abs);
      out.push({ store: store.id, rel, title: e.name.replace(/\.md$/, ''), mtimeMs: st.mtimeMs, bytes: st.size });
    }
  }
}

const listCache = new Map<string, { at: number; files: MemFile[] }>();

/** Every live memory file in a store, newest first. Cached for one minute. */
export function listStore(id: string): MemFile[] {
  const store = storeById(id);
  if (!store) return [];
  const hit = listCache.get(id);
  if (hit && Date.now() - hit.at < 60_000) return hit.files;
  const files: MemFile[] = [];
  walk(store, store.root, files);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  listCache.set(id, { at: Date.now(), files });
  return files;
}

/** Absolute path of a live memory file, or null if it leaves the store or is not one. */
export function resolveMemFile(id: string, rel: string): string | null {
  const store = storeById(id);
  if (!store || !rel || rel.includes('\0')) return null;
  let root: string;
  let abs: string;
  try {
    root = fs.realpathSync(store.root);
    abs = fs.realpathSync(path.resolve(root, rel));
  } catch {
    return null;
  }
  if (!abs.startsWith(root + path.sep)) return null;
  if (!included(store, path.relative(root, abs))) return null;
  return fs.statSync(abs).isFile() ? abs : null;
}

/** Find a vault note by its [[wikilink]] name. */
export function findNote(id: string, name: string): string | null {
  const want = name.trim().toLowerCase();
  const files = listStore(id);
  const byPath = files.find((f) => f.rel.toLowerCase().replace(/\.md$/, '') === want);
  if (byPath) return byPath.rel;
  const base = want.split('/').pop();
  return files.find((f) => f.title.toLowerCase() === base)?.rel ?? null;
}

export interface MemHit extends MemFile {
  count: number;
  lines: { n: number; text: string }[];
}

const RG = ['/opt/homebrew/bin/rg', '/usr/local/bin/rg'].find((p) => fs.existsSync(p)) ?? 'rg';

function rg(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(RG, args, { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 20_000 }, (_err, stdout) => resolve(stdout ?? ''));
  });
}

// A short window of the line, starting just before the first matching word.
function around(line: string, words: string[]): string {
  const at = Math.min(...words.map((w) => line.toLowerCase().indexOf(w)).filter((i) => i >= 0));
  const start = at > 40 ? line.lastIndexOf(' ', at - 30) + 1 : 0;
  const cut = line.slice(start, start + 160);
  return (start > 0 ? '…' : '') + cut + (start + 160 < line.length ? '…' : '');
}

/**
 * Plain text search over the live memory files. Every word must appear in the file.
 * Ranked by how often the words appear, newer first on ties.
 */
export async function searchMemory(q: string, ids: string[], limit = 40): Promise<{ hits: MemHit[]; total: number; files: number }> {
  const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 1).slice(0, 8);
  const stores = ids.map(storeById).filter((s): s is Store => !!s && fs.existsSync(s.root));
  const files = stores.reduce((n, s) => n + listStore(s.id).length, 0);
  if (words.length === 0) return { hits: [], total: 0, files };
  const hits: MemHit[] = [];
  for (const store of stores) {
    const live = new Map(listStore(store.id).map((f) => [f.rel, f]));
    // Count matches of each word per file; a file is a hit when every word appears.
    const perWord = await Promise.all(
      words.map((w) => rg(['--no-ignore', '-i', '-F', '-c', '--glob', '*.md', '--', w, '.'], store.root)),
    );
    const counts = new Map<string, number[]>();
    perWord.forEach((out, wi) => {
      for (const line of out.split('\n')) {
        const m = line.match(/^(.*):(\d+)$/);
        if (!m) continue;
        const rel = path.normalize(m[1]);
        if (!live.has(rel)) continue;
        const arr = counts.get(rel) ?? new Array(words.length).fill(0);
        arr[wi] = Number(m[2]);
        counts.set(rel, arr);
      }
    });
    for (const [rel, arr] of counts) {
      if (arr.some((c) => c === 0)) continue;
      hits.push({ ...live.get(rel)!, count: arr.reduce((a, b) => a + b, 0), lines: [] });
    }
  }
  hits.sort((a, b) => b.count - a.count || b.mtimeMs - a.mtimeMs);
  const top = hits.slice(0, limit);
  // Matching lines for the files shown only.
  for (const h of top) {
    try {
      const text = fs.readFileSync(path.join(storeById(h.store)!.root, h.rel), 'utf8').split('\n');
      h.lines = text
        .map((t, i) => ({ n: i + 1, text: t.trim() }))
        .filter((l) => words.some((w) => l.text.toLowerCase().includes(w)))
        .slice(0, 2)
        .map((l) => ({ n: l.n, text: around(l.text.replace(/\*\*|`/g, ''), words) }));
    } catch {
      // file moved between list and read: show it without lines
    }
  }
  return { hits: top, total: hits.length, files };
}

/** Description line of a saved lesson (its frontmatter `description:`), if any. */
export function lessonDescription(abs: string): string {
  try {
    const head = fs.readFileSync(abs, 'utf8').slice(0, 800);
    return head.match(/^description:\s*(.+)$/m)?.[1].trim() ?? '';
  } catch {
    return '';
  }
}

export interface GraphSummary {
  builtAt: string;
  nodes: number;
  links: number;
  groups: number;
  hubs: { label: string; links: number; rel: string | null }[];
}

let graphCache: { mtimeMs: number; summary: GraphSummary } | null = null;

/** The graphify graph of the vault: size, when it was built, and the notes with the most links. */
export function graphSummary(): GraphSummary | null {
  if (!VAULT) return null;
  const file = path.join(VAULT, 'graphify-out', 'graph.json');
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  if (graphCache?.mtimeMs === st.mtimeMs) return graphCache.summary;
  try {
    const g = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      nodes: { id: string; label?: string; file_type?: string; source_file?: string; community?: number }[];
      links: { source: string; target: string }[];
    };
    const degree = new Map<string, number>();
    for (const l of g.links) {
      degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
      degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
    }
    const hubs = g.nodes
      .filter((n) => n.file_type === 'document' && !(n.label ?? '').startsWith('#') && n.source_file?.startsWith(VAULT + path.sep))
      .map((n) => ({ label: n.label ?? n.id, links: degree.get(n.id) ?? 0, rel: path.relative(VAULT, n.source_file!) }))
      .sort((a, b) => b.links - a.links)
      .slice(0, 8)
      .map((h) => ({ ...h, rel: resolveMemFile('brain', h.rel) ? h.rel : null }));
    const summary = {
      builtAt: st.mtime.toISOString(),
      nodes: g.nodes.length,
      links: g.links.length,
      groups: new Set(g.nodes.map((n) => n.community).filter((c) => c !== undefined)).size,
      hubs,
    };
    graphCache = { mtimeMs: st.mtimeMs, summary };
    return summary;
  } catch {
    return null;
  }
}

export interface ClientPromise {
  due: string;
  what: string;
  client: string;
  covered: boolean;
  source: string;
}

/** Promises we made to clients, as kept in CTX_ROOT/state/client-commitments.json. */
export function clientPromises(): ClientPromise[] | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(CTX_ROOT, 'state', 'client-commitments.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Day the client promises file was last written, so a stale list reads as stale. */
export function clientPromisesAt(): string {
  try {
    return fs.statSync(path.join(CTX_ROOT, 'state', 'client-commitments.json')).mtime.toISOString().slice(0, 10);
  } catch {
    return 'unknown';
  }
}
