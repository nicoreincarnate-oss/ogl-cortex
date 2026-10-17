// Client work on disk: ~/Clients/<Client> - Projects|Coaching/ and ~/Clients/_Prospects/<name>/.
// Files follow the Luke naming: "<Client> - <Project or Session N> - <Doc type> (<YYYY-MM-DD>).<ext>".
// Read-only. Shown on the Projects and CRM tabs.
import fs from 'fs';
import os from 'os';
import path from 'path';

export const CLIENTS_ROOT = process.env.CTX_CLIENTS_ROOT ?? path.join(os.homedir(), 'Clients');

export interface ClientFile {
  name: string;
  relPath: string;
  project: string;
  docType: string;
  date: string | null;
  mtimeMs: number;
}

export interface ClientFolder {
  client: string;
  kind: 'Projects' | 'Coaching' | 'Prospect';
  folder: string;
  files: ClientFile[];
  projects: { name: string; files: ClientFile[]; latest: string }[];
  latest: string | null;
}

const NAME_RE = /^(.+?) - (.+?) - (.+?) \((\d{4}-\d{2}-\d{2})\)\.[^.]+$/;

function walk(dir: string, out: string[]) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, out);
    else if (e.isFile()) out.push(abs);
  }
}

function readFolder(abs: string, client: string, kind: ClientFolder['kind']): ClientFolder {
  const paths: string[] = [];
  walk(abs, paths);
  const files: ClientFile[] = paths.map((p) => {
    const name = path.basename(p);
    const m = name.match(NAME_RE);
    return {
      name,
      relPath: path.relative(CLIENTS_ROOT, p),
      project: m ? m[2] : 'Other',
      docType: m ? m[3] : name.replace(/\.[^.]+$/, ''),
      date: m ? m[4] : null,
      mtimeMs: fs.statSync(p).mtimeMs,
    };
  });
  const when = (f: ClientFile) => f.date ?? new Date(f.mtimeMs).toISOString().slice(0, 10);
  files.sort((a, b) => when(b).localeCompare(when(a)) || b.mtimeMs - a.mtimeMs);
  const byProject = new Map<string, ClientFile[]>();
  for (const f of files) byProject.set(f.project, [...(byProject.get(f.project) ?? []), f]);
  const projects = [...byProject.entries()]
    .map(([name, fs_]) => ({ name, files: fs_, latest: when(fs_[0]) }))
    .sort((a, b) => b.latest.localeCompare(a.latest));
  return { client, kind, folder: path.relative(CLIENTS_ROOT, abs), files, projects, latest: files[0] ? when(files[0]) : null };
}

export function getClientFolders(): { clients: ClientFolder[]; prospects: ClientFolder[]; error?: string } {
  try {
    const clients: ClientFolder[] = [];
    const prospects: ClientFolder[] = [];
    for (const e of fs.readdirSync(CLIENTS_ROOT, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const abs = path.join(CLIENTS_ROOT, e.name);
      if (e.name === '_Prospects') {
        for (const p of fs.readdirSync(abs, { withFileTypes: true })) {
          if (p.isDirectory() && !p.name.startsWith('.')) prospects.push(readFolder(path.join(abs, p.name), p.name, 'Prospect'));
        }
        continue;
      }
      if (e.name.startsWith('_')) continue;
      const m = e.name.match(/^(.+) - (Projects|Coaching)$/);
      clients.push(readFolder(abs, m ? m[1] : e.name, m ? (m[2] as 'Projects' | 'Coaching') : 'Projects'));
    }
    const byLatest = (a: ClientFolder, b: ClientFolder) => (b.latest ?? '').localeCompare(a.latest ?? '');
    return { clients: clients.sort(byLatest), prospects: prospects.sort(byLatest) };
  } catch (err) {
    return { clients: [], prospects: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** Absolute path of a client file, or null if the path leaves ~/Clients or is not a file. */
export function resolveClientFile(relPath: string): string | null {
  if (!relPath || relPath.includes('\0')) return null;
  const root = fs.realpathSync(CLIENTS_ROOT);
  let abs: string;
  try {
    abs = fs.realpathSync(path.resolve(root, relPath));
  } catch {
    return null;
  }
  if (!abs.startsWith(root + path.sep)) return null;
  if (path.basename(abs).startsWith('.')) return null;
  return fs.statSync(abs).isFile() ? abs : null;
}
