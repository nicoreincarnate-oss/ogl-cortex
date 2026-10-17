import path from 'path';
import Link from 'next/link';
import { storeById, listStore, lessonDescription } from '@/lib/data/memory-stores';

export const dynamic = 'force-dynamic';

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export default async function BrowseMemoryPage({ searchParams }: { searchParams: Promise<{ store?: string; dir?: string }> }) {
  const sp = await searchParams;
  const store = storeById(sp.store ?? '');
  const dir = (sp.dir ?? '').replace(/^\/+|\/+$/g, '');
  if (!store) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-8">
        <Link href="/knowledge-base" className="font-mono text-xs underline">Back to Knowledge Base</Link>
        <p role="alert" className="font-mono text-xs text-destructive">No memory store called {sp.store}.</p>
      </div>
    );
  }
  const all = listStore(store.id);
  const inDir = all.filter((f) => (dir ? f.rel.startsWith(dir + path.sep) : true));
  const here = inDir.filter((f) => path.dirname(f.rel) === (dir || '.'));
  const sub = new Map<string, { n: number; latest: number }>();
  for (const f of inDir) {
    const rest = dir ? f.rel.slice(dir.length + 1) : f.rel;
    if (!rest.includes(path.sep)) continue;
    const name = rest.split(path.sep)[0];
    const prev = sub.get(name) ?? { n: 0, latest: 0 };
    sub.set(name, { n: prev.n + 1, latest: Math.max(prev.latest, f.mtimeMs) });
  }
  const folders = [...sub.entries()].sort((a, b) => b[1].latest - a[1].latest);
  const href = (d: string) => `/knowledge-base/browse?store=${encodeURIComponent(store.id)}${d ? `&dir=${encodeURIComponent(d)}` : ''}`;
  const crumbs = dir ? dir.split(path.sep) : [];
  const shown = here.slice(0, 300);
  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 md:p-8">
      <div className="space-y-2 border-b-2 border-foreground pb-3">
        <p className="flex flex-wrap gap-x-2 font-mono text-[11px]">
          <Link href="/knowledge-base" className="underline">Knowledge Base</Link>
          <span>/</span>
          <Link href={href('')} className="underline">{store.label}</Link>
          {crumbs.map((c, i) => (
            <span key={i} className="flex gap-x-2">
              <span>/</span>
              <Link href={href(crumbs.slice(0, i + 1).join(path.sep))} className="underline">{c}</Link>
            </span>
          ))}
        </p>
        <h1 className="text-4xl leading-none" data-ogl-title>{crumbs[crumbs.length - 1] ?? store.label}</h1>
        <p className="font-mono text-[11px] text-muted-foreground">{inDir.length} file{inDir.length === 1 ? '' : 's'}, newest first</p>
      </div>
      {folders.length > 0 && (
        <ul className="grid gap-2 sm:grid-cols-2">
          {folders.map(([name, f]) => (
            <li key={name}>
              <Link href={href(dir ? path.join(dir, name) : name)} className="flex items-baseline justify-between gap-2 border-2 border-foreground p-3 hover:bg-muted">
                <span className="min-w-0 truncate font-medium">{name}</span>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{f.n} · {day(f.latest)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {shown.length > 0 && (
        <ul className="divide-y divide-border">
          {shown.map((f) => (
            <li key={f.rel}>
              <Link href={`/knowledge-base/doc?store=${encodeURIComponent(store.id)}&path=${encodeURIComponent(f.rel)}`} className="block py-2 hover:text-primary">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate">{f.title}</span>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{day(f.mtimeMs)}</span>
                </span>
                {store.group === 'lessons' && (
                  <span className="line-clamp-2 block text-xs text-muted-foreground">{lessonDescription(path.join(store.root, f.rel))}</span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {here.length > shown.length && (
        <p className="font-mono text-[11px] text-muted-foreground">{here.length - shown.length} older files here. Search to find them.</p>
      )}
    </div>
  );
}
