// Plain-English task lines for the Team page.
// A task title is rewritten once (Haiku, one batched call), cached by task id + title, and shown with the
// raw title underneath. Missing lines render as the raw title and are filled in the background:
// a page load never waits on the model, and a failed call leaves the raw title (never a guess).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { CTX_ROOT } from '@/lib/config';

const CACHE = path.join(CTX_ROOT, 'dashboard', 'plain-titles.json');
const MODEL = 'claude-haiku-4-5-20251001';
// The dashboard may start without a login shell PATH: look in the usual install places.
const CLAUDE = ['/opt/homebrew/bin/claude', path.join(os.homedir(), '.local/bin/claude'), '/usr/local/bin/claude'].find((p) => fs.existsSync(p)) ?? 'claude';
const MAX_PER_CALL = 25;

type Cache = Record<string, { title: string; plain: string }>;

let running = false;

function readCache(): Cache {
  try {
    return JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  } catch {
    return {};
  }
}

export function plainFor(id: string, title: string): string | null {
  const hit = readCache()[id];
  return hit && hit.title === title ? hit.plain : null;
}

export function buildPrompt(items: { id: string; title: string }[]): string {
  return [
    'Rewrite each task title below as one plain English sentence that a busy business owner understands at a glance:',
    'what is being done and what it is for. At most 16 words. No ids, no file names, no abbreviations, no jargon.',
    'Keep client and person names. If a title is too unclear to rewrite, say plainly what you can tell from it.',
    'Answer with only a JSON object mapping each id to its sentence.',
    '',
    ...items.map((t) => `${t.id}: ${t.title}`),
  ].join('\n');
}

export function parseAnswer(text: string, ids: string[]): Record<string, string> {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return {};
  try {
    const obj = JSON.parse(m[0]) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const id of ids) {
      const v = obj[id];
      if (typeof v === 'string' && v.trim()) out[id] = v.trim();
    }
    return out;
  } catch {
    return {};
  }
}

// Fire and forget: fills the cache for titles it has not seen. One call at a time per server.
export function fillMissing(tasks: { id: string; title: string }[]): void {
  if (running) return;
  const cache = readCache();
  const todo = tasks.filter((t) => cache[t.id]?.title !== t.title).slice(0, MAX_PER_CALL);
  if (todo.length === 0) return;
  running = true;

  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !k.startsWith('CLAUDE') && !k.startsWith('CTX_') && k !== 'ANTHROPIC_API_KEY' && k !== 'ANTHROPIC_AUTH_TOKEN',
    ),
  ) as NodeJS.ProcessEnv;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ogl-plain-'));
  const child = spawn(
    CLAUDE,
    ['-p', '--model', MODEL, '--setting-sources', '', '--strict-mcp-config', '--output-format', 'json'],
    { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] },
  );
  let out = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  // a missing binary must not crash the server: raw titles stay
  child.on('error', () => {
    clearTimeout(timer);
    running = false;
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  child.on('close', () => {
    clearTimeout(timer);
    running = false;
    fs.rmSync(cwd, { recursive: true, force: true });
    try {
      const result = JSON.parse(out).result as string;
      const answers = parseAnswer(result, todo.map((t) => t.id));
      const fresh = readCache();
      for (const t of todo) if (answers[t.id]) fresh[t.id] = { title: t.title, plain: answers[t.id] };
      fs.mkdirSync(path.dirname(CACHE), { recursive: true });
      fs.writeFileSync(CACHE, JSON.stringify(fresh, null, 1));
    } catch {
      /* the raw titles stay on the page; nothing is invented */
    }
  });
  child.stdin.end(buildPrompt(todo));
}
