import { NextRequest } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { getCTXRoot, getFrameworkRoot } from '@/lib/config';

export const dynamic = 'force-dynamic';

const execFileAsync = promisify(execFile);

// Listing collections loads ChromaDB in Python (~12s). Keep the last list per org for 10 minutes;
// after that serve it at once and refresh behind the request (10-17).
const TTL_MS = 10 * 60 * 1000;
const listCache = new Map<string, { at: number; collections: Array<{ name: string; count: number }> }>();
const inFlight = new Map<string, Promise<Array<{ name: string; count: number }>>>();

/**
 * GET /api/kb/collections?org=<org>
 *
 * Lists knowledge base collections and document counts for an org.
 *
 * Response:
 * {
 *   collections: Array<{ name: string, count: number }>,
 *   org: string
 * }
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const org = searchParams.get('org') || '';

  if (!org || !/^[a-z0-9_-]+$/.test(org)) {
    return Response.json({ error: 'org parameter required (lowercase alphanumeric, hyphens, underscores)' }, { status: 400 });
  }

  const frameworkRoot = getFrameworkRoot();
  const ctxRoot = getCTXRoot();
  const instanceId = path.basename(ctxRoot);

  const kbRoot = path.join(os.homedir(), '.cortextos', instanceId, 'orgs', org, 'knowledge-base');
  const chromaDir = path.join(kbRoot, 'chromadb');
  const configPath = path.join(kbRoot, 'config.json');
  const isWin = process.platform === 'win32';
  const venvBin = isWin ? 'Scripts' : 'bin';
  const pythonExe = isWin ? 'python.exe' : 'python3';
  const pythonPath = path.join(frameworkRoot, 'knowledge-base', 'venv', venvBin, pythonExe);
  const mmragPath = path.join(frameworkRoot, 'knowledge-base', 'scripts', 'mmrag.py');

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CTX_FRAMEWORK_ROOT: frameworkRoot,
    CTX_INSTANCE_ID: instanceId,
    CTX_ORG: org,
    PATH: process.env.PATH ?? '',
    MMRAG_DIR: kbRoot,
    MMRAG_CHROMADB_DIR: chromaDir,
    MMRAG_CONFIG: configPath,
  };

  // Load GEMINI_API_KEY from secrets if available
  const secretsPath = path.join(frameworkRoot, 'orgs', org, 'secrets.env');
  try {
    const secrets = readFileSync(secretsPath, 'utf-8');
    const match = secrets.match(/^GEMINI_API_KEY=(.+)$/m);
    if (match) env.GEMINI_API_KEY = match[1].trim();
  } catch {
    // No secrets file — GEMINI_API_KEY may be in process.env already
  }
  if (!env.GEMINI_API_KEY && process.env.GEMINI_API_KEY) {
    env.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  }

  // Pre-flight checks matching kb-collections.sh behavior
  if (!existsSync(path.join(frameworkRoot, 'knowledge-base', 'venv'))) {
    return Response.json({ collections: [], org });
  }
  if (!existsSync(chromaDir)) {
    return Response.json({ collections: [], org });
  }

  // Helper: parse tabular output from mmrag.py collections command
  function parseCollectionsOutput(rawOut: string): Array<{ name: string; count: number }> {
    const collections: Array<{ name: string; count: number }> = [];
    for (const line of rawOut.trim().split('\n')) {
      if (!line || line.startsWith('Collection') || line.startsWith('---')) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        const count = parseInt(parts[parts.length - 1], 10);
        const name = parts.slice(0, parts.length - 1).join(' ');
        if (name && !isNaN(count)) {
          collections.push({ name, count });
        }
      }
    }
    return collections;
  }

  const load = async (): Promise<Array<{ name: string; count: number }>> => {
    let rawOut = '';
    try {
      rawOut = (await execFileAsync(pythonPath, [mmragPath, 'collections'], {
        timeout: 15000,
        encoding: 'utf-8',
        env: env as NodeJS.ProcessEnv,
      })).stdout;
    } catch (err: unknown) {
      // ChromaDB may crash mid-output (e.g. pickle corruption) after printing some collections.
      // Recover partial stdout rather than returning 500.
      const execErr = err as { stdout?: string; message?: string };
      rawOut = execErr.stdout || '';
      if (!rawOut) {
        const message = execErr.message || String(err);
        if (
          message.includes('not set up') ||
          message.includes('No collections') ||
          message.includes('not found')
        ) {
          return [];
        }
        console.error('[api/kb/collections] Error:', message);
        return [];
      }
    }
    return parseCollectionsOutput(rawOut);
  };

  const refresh = () => {
    let p = inFlight.get(org);
    if (!p) {
      p = load()
        .then((collections) => {
          // An empty list from a failed run must not replace a good one.
          if (collections.length > 0 || !listCache.has(org)) listCache.set(org, { at: Date.now(), collections });
          return collections;
        })
        .finally(() => inFlight.delete(org));
      inFlight.set(org, p);
    }
    return p;
  };

  const hit = listCache.get(org);
  if (hit) {
    if (Date.now() - hit.at > TTL_MS) void refresh();
    return Response.json({ collections: hit.collections, org });
  }
  return Response.json({ collections: await refresh(), org });
}
