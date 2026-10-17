import Link from 'next/link';
import { marked } from 'marked';
import DOMPurify from 'isomorphic-dompurify';
import { STORES, searchMemory, clientPromises } from '@/lib/data/memory-stores';
import { getEntities, kindOf } from '@/lib/data/memory-hub';

export const dynamic = 'force-dynamic';

const docHref = (store: string, rel: string) => `/knowledge-base/doc?store=${encodeURIComponent(store)}&path=${encodeURIComponent(rel)}`;
const label = (id: string) => STORES.find((s) => s.id === id)?.label.replace("'s lessons", '') ?? id;

// One person or company: who they are, their notes, promises that name them, and every memory file that mentions them, newest first.
export default async function EntityPage({ searchParams }: { searchParams: Promise<{ name?: string }> }) {
  const name = ((await searchParams).name ?? '').trim();
  const e = getEntities().find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!e) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-8">
        <Link href="/knowledge-base" className="font-mono text-xs underline">Back to Knowledge Base</Link>
        <p role="alert" className="font-mono text-xs text-destructive">No person or company called {name || '(none)'} in our memory.</p>
      </div>
    );
  }
  const memoryIds = STORES.filter((s) => s.group !== 'blueprint').map((s) => s.id);
  const found = await searchMemory(e.name, memoryIds, 60);
  const mentions = [...found.hits].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const first = e.name.toLowerCase().split(/\s+/)[0];
  const promises = (clientPromises() ?? []).filter((p) => `${p.client} ${p.what}`.toLowerCase().includes(first));
  const entry = e.entry
    ? DOMPurify.sanitize(marked.parseInline(e.entry) as string, { USE_PROFILES: { html: true }, FORBID_ATTR: ['style'] })
    : '';
  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 md:p-8">
      <div className="space-y-2 border-b-2 border-foreground pb-3">
        <p className="flex flex-wrap gap-x-2 font-mono text-[11px]">
          <Link href="/knowledge-base" className="underline">Knowledge Base</Link>
          <span>/</span>
          <Link href="/knowledge-base#people" className="underline">People &amp; companies</Link>
        </p>
        <p className="inline-block bg-foreground px-2 py-1 font-mono text-[11px] uppercase tracking-widest text-background">{e.kind}</p>
        <h1 className="text-4xl leading-none" data-ogl-title>{e.name}</h1>
        {e.line && <p className="text-base text-muted-foreground">{e.line}</p>}
      </div>

      {entry && (
        <section className="space-y-1">
          <h2 className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">What we know</h2>
          <details className="group">
            <summary className="cursor-pointer list-none">
              <p className="line-clamp-5 text-sm leading-relaxed group-open:line-clamp-none [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:text-[13px]" dangerouslySetInnerHTML={{ __html: entry }} />
              <span className="font-mono text-[11px] underline group-open:hidden">Read all</span>
            </summary>
          </details>
        </section>
      )}

      {e.notes.length > 0 && (
        <section className="space-y-1">
          <h2 className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">Their page in the brain</h2>
          <ul>
            {e.notes.map((n) => (
              <li key={n.rel}><Link href={docHref(n.store, n.rel)} className="underline">{n.title}</Link></li>
            ))}
          </ul>
        </section>
      )}

      {promises.length > 0 && (
        <section className="space-y-1">
          <h2 className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">Promises</h2>
          <ul className="divide-y divide-border text-sm">
            {promises.map((p, i) => (
              <li key={i} className="flex items-baseline justify-between gap-3 py-2">
                <span>{p.what}</span>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{p.due.slice(0, 10)}{p.covered ? ' · kept' : ''}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-1">
        <h2 className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          Mentioned in {found.total} file{found.total === 1 ? '' : 's'}, newest first{found.total > mentions.length ? ` (latest ${mentions.length} by relevance)` : ''}
        </h2>
        <ul className="divide-y divide-border">
          {mentions.map((h) => (
            <li key={h.store + h.rel} className="py-2">
              <Link href={docHref(h.store, h.rel)} className="flex items-baseline justify-between gap-3 hover:text-primary">
                <span className="min-w-0 truncate">{/^\d{4}-\d{2}-\d{2}$/.test(h.title) ? `Daily log ${h.title}` : h.title.replace(/-/g, ' ')}</span>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{kindOf(h)} · {label(h.store)} · {new Date(h.mtimeMs).toISOString().slice(0, 10)}</span>
              </Link>
              {h.lines[0] && <p className="line-clamp-2 text-[13px] text-muted-foreground">{h.lines[0].text}</p>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
