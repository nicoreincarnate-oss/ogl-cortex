import { defaultOrg } from '@/lib/install';
import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import {
  getVaultRoot,
  getVaultDirs,
  listAllNotes,
  parseFrontmatter,
  firstMeaningfulLine,
} from '@/lib/vault';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const org = url.searchParams.get('org') || defaultOrg();

  const vaultRoot = getVaultRoot(org);
  if (!vaultRoot) {
    return Response.json({ error: `Vault not found for org "${org}"` }, { status: 404 });
  }

  // PARA vault: the 00-inbox folder. Any other vault: its 50 most recently changed notes.
  const isPara = getVaultDirs(vaultRoot).includes('00-inbox');
  const files = isPara
    ? fs.readdirSync(path.join(vaultRoot, '00-inbox'), { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('.'))
        .map((e) => ({ relPath: path.join('00-inbox', e.name), absPath: path.join(vaultRoot, '00-inbox', e.name) }))
    : listAllNotes(vaultRoot).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 50);

  const items = [];
  for (const f of files) {
    const stat = fs.statSync(f.absPath);
    let frontmatter = {};
    let excerpt = '';

    try {
      const raw = fs.readFileSync(f.absPath, 'utf-8');
      const parsed = parseFrontmatter(raw);
      frontmatter = parsed.frontmatter;
      excerpt = firstMeaningfulLine(parsed.body);
    } catch {
      /* tolerate read errors — surface row anyway */
    }

    items.push({
      filename: path.basename(f.relPath),
      relPath: f.relPath,
      mtimeMs: stat.mtimeMs,
      sizeBytes: stat.size,
      frontmatter,
      excerpt,
    });
  }

  items.sort((a, b) => b.mtimeMs - a.mtimeMs);

  return Response.json({ vaultRoot, items });
}
