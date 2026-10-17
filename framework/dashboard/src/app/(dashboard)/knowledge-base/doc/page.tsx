import fs from 'fs';
import path from 'path';
import Link from 'next/link';
import { marked } from 'marked';
import DOMPurify from 'isomorphic-dompurify';
import { REPO_URL, refreshMirror } from '@/lib/data/ogl-cortex';
import { storeById, resolveMemFile, findNote } from '@/lib/data/memory-stores';

export const dynamic = 'force-dynamic';

const docHref = (store: string, rel: string) => `/knowledge-base/doc?store=${encodeURIComponent(store)}&path=${encodeURIComponent(rel)}`;

// [[Note]] and [[Note|shown text]] become links to the note when it exists in the same store.
function wikilinks(md: string, store: string): string {
  return md.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_w, name: string, shown?: string) => {
    const rel = findNote(store, name);
    const text = (shown ?? name).replace(/[[\]]/g, '');
    return rel ? `[${text}](${docHref(store, rel).replace(/\)/g, '%29')})` : text;
  });
}

// Links between files stay in the app; repo links that are not markdown go to GitHub.
function rewriteLinks(html: string, store: string, rel: string): string {
  return html.replace(/href="([^"#:]+?)(#[^"]*)?"/g, (whole, target: string, hash = '') => {
    if (target.startsWith('/')) return whole;
    const joined = path.posix.normalize(path.posix.join(path.posix.dirname(rel), decodeURIComponent(target)));
    if (joined.startsWith('..')) return whole;
    if (joined.endsWith('.md')) return `href="${docHref(store, joined)}${hash}"`;
    if (store === 'blueprint') return `href="${REPO_URL}/blob/main/${joined}${hash}" target="_blank" rel="noreferrer"`;
    return whole;
  });
}

export default async function MemoryDocPage({ searchParams }: { searchParams: Promise<{ store?: string; path?: string }> }) {
  const sp = await searchParams;
  const storeId = sp.store ?? 'blueprint';
  if (storeId === 'blueprint') refreshMirror();
  const store = storeById(storeId);
  const relPath = sp.path ?? '';
  const abs = store ? resolveMemFile(storeId, relPath) : null;
  if (!store || !abs) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-8">
        <Link href="/knowledge-base" className="font-mono text-xs underline">Back to Knowledge Base</Link>
        <p role="alert" className="border-2 border-destructive px-3 py-2 font-mono text-xs text-destructive">
          No memory file at {relPath || '(no path)'}{store ? ` in ${store.label}` : ''}.
        </p>
      </div>
    );
  }
  const rel = path.relative(fs.realpathSync(store.root), abs);
  const st = fs.statSync(abs);
  const raw = fs.readFileSync(abs, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '');
  const html = rewriteLinks(
    DOMPurify.sanitize(marked.parse(wikilinks(raw, storeId)) as string, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'link', 'meta', 'base'],
      FORBID_ATTR: ['style'],
    }),
    storeId,
    rel,
  );
  const dir = path.dirname(rel);
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-8">
      <div className="space-y-1 border-b-2 border-foreground pb-3 font-mono text-[11px]">
        <p className="flex flex-wrap gap-x-2">
          <Link href="/knowledge-base" className="underline">Knowledge Base</Link>
          <span>/</span>
          <Link href={`/knowledge-base/browse?store=${encodeURIComponent(storeId)}`} className="underline">{store.label}</Link>
          {dir !== '.' && (
            <>
              <span>/</span>
              <Link href={`/knowledge-base/browse?store=${encodeURIComponent(storeId)}&dir=${encodeURIComponent(dir)}`} className="underline">{dir}</Link>
            </>
          )}
        </p>
        <p className="text-muted-foreground">
          changed {st.mtime.toISOString().slice(0, 16).replace('T', ' ')} UTC
          {storeId === 'blueprint' && (
            <> · <a href={`${REPO_URL}/blob/main/${rel}`} target="_blank" rel="noreferrer" className="underline">on GitHub</a></>
          )}
        </p>
      </div>
      <article
        className="break-words text-[15px] leading-relaxed [&_a]:text-primary [&_a]:underline [&_blockquote]:border-l-4 [&_blockquote]:border-primary [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-[13px] [&_h1]:mb-4 [&_h1]:text-4xl [&_h1]:leading-none [&_h2]:mt-8 [&_h2]:mb-2 [&_h2]:border-b [&_h2]:border-border [&_h2]:pb-1 [&_h2]:text-2xl [&_h3]:mt-6 [&_h3]:mb-1 [&_h3]:text-lg [&_h3]:font-semibold [&_hr]:my-6 [&_hr]:border-border [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-3 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:my-4 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:text-[13px] [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_td]:align-top [&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_ul]:list-disc [&_ul]:pl-6"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
