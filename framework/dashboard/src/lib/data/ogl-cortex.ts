// The OGL Cortex repo (github.com/nicoreincarnate-oss/ogl-cortex): our memory architecture and the full reference docs.
// Read from a local mirror, CTX_ROOT/mirrors/ogl-cortex, refreshed from GitHub at most every 10 minutes
// with `gh repo sync` under the OGL GitHub login. Read-only. Read through lib/data/memory-stores.ts as the 'blueprint' store.
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { CTX_ROOT } from '@/lib/config';
import { GH_CONFIG_DIR } from '@/lib/install';

export const MIRROR = path.join(CTX_ROOT, 'mirrors', 'ogl-cortex');
export const REPO_URL = 'https://github.com/nicoreincarnate-oss/ogl-cortex';
const REFRESH_MS = 10 * 60 * 1000;

let lastSync = 0;
let syncing = false;

/** Start a background pull if the mirror is older than 10 minutes. Never blocks a page. */
export function refreshMirror() {
  if (syncing || Date.now() - lastSync < REFRESH_MS || !fs.existsSync(path.join(MIRROR, '.git'))) return;
  syncing = true;
  execFile(
    'gh',
    ['repo', 'sync'],
    { cwd: MIRROR, timeout: 60_000, env: { ...process.env, ...(GH_CONFIG_DIR && { GH_CONFIG_DIR }) } },
    () => {
      lastSync = Date.now();
      syncing = false;
    },
  );
}
