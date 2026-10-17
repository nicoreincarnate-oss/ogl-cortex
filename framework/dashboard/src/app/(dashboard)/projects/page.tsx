import Link from 'next/link';
import { ProofHeader } from '@/components/proof/proof-header';
import { getClientFolders, type ClientFolder, type ClientFile } from '@/lib/data/clients';
import { getTasks } from '@/lib/data/tasks';
import type { Task } from '@/lib/types';

export const dynamic = 'force-dynamic';

// Words that name a client in a task title: every word of 4+ letters, or an acronym like OGL.
function keysFor(client: string): string[] {
  return client
    .split(/[\s]+/)
    .filter((w) => (w.length >= 4 && !/^(hotel|projects)$/i.test(w)) || /^[A-Z]{3,}$/.test(w))
    .map((w) => w.toLowerCase());
}

const fileHref = (f: ClientFile) => `/api/clients/file?path=${encodeURIComponent(f.relPath)}`;

function FileLink({ f }: { f: ClientFile }) {
  return (
    <a href={fileHref(f)} target="_blank" rel="noreferrer" className="flex items-baseline justify-between gap-3 py-1.5 hover:text-primary">
      <span className="min-w-0 flex-1 truncate">{f.docType}</span>
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{f.date ?? ''}</span>
    </a>
  );
}

function ClientCard({ c, open }: { c: ClientFolder; open: Task[] }) {
  return (
    <article data-slot="card" className="space-y-3 rounded-md bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-3xl leading-none" data-ogl-title>{c.client}</h2>
        <span className="font-mono text-[11px] uppercase text-muted-foreground">
          {c.kind} · {c.files.length} file{c.files.length === 1 ? '' : 's'}{c.latest ? ` · last ${c.latest}` : ''}
        </span>
      </div>
      {open.length > 0 && (
        <details className="border-l-4 border-primary pl-3">
          <summary className="cursor-pointer text-sm font-medium">{open.length} open task{open.length === 1 ? '' : 's'} on this</summary>
          <ul className="mt-1 space-y-1 text-sm">
            {open.slice(0, 8).map((t) => (
              <li key={t.id} className="leading-snug">
                <Link href={`/tasks?search=${encodeURIComponent(t.id)}`} className="hover:text-primary">{t.title}</Link>
                <span className="ml-2 font-mono text-[11px] text-muted-foreground">{t.assignee} · {t.status}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="divide-y divide-border">
        {c.projects.slice(0, 4).map((p) => (
          <section key={p.name} className="py-2">
            <h3 className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">{p.name}</h3>
            {p.files.slice(0, 2).map((f) => <FileLink key={f.relPath} f={f} />)}
            {p.files.length > 2 && (
              <details>
                <summary className="cursor-pointer font-mono text-[11px] text-muted-foreground">{p.files.length - 2} more</summary>
                {p.files.slice(2).map((f) => <FileLink key={f.relPath} f={f} />)}
              </details>
            )}
          </section>
        ))}
        {c.projects.length > 4 && (
          <details className="py-2">
            <summary className="cursor-pointer font-mono text-[11px] text-muted-foreground">{c.projects.length - 4} older projects</summary>
            {c.projects.slice(4).map((p) => (
              <section key={p.name} className="py-1">
                <h3 className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">{p.name}</h3>
                {p.files.map((f) => <FileLink key={f.relPath} f={f} />)}
              </section>
            ))}
          </details>
        )}
      </div>
    </article>
  );
}

export default function ProjectsPage() {
  const { clients, prospects, error } = getClientFolders();
  const open = getTasks().filter((t) => ['pending', 'in_progress', 'blocked'].includes(t.status as string));
  const tasksFor = (c: ClientFolder) => {
    const keys = keysFor(c.client);
    return open.filter((t) => keys.some((k) => t.title.toLowerCase().includes(k)));
  };
  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4 md:p-8">
      <ProofHeader kicker="Your clients" title="Projects" readAt={new Date().toISOString()} source="client folders + current tasks" error={error}>
        Every client and what we have made for them, newest first. Tap a document to open it.
      </ProofHeader>
      {clients.map((c) => <ClientCard key={c.folder} c={c} open={tasksFor(c)} />)}
      {prospects.length > 0 && (
        <>
          <h2 className="pt-2 text-2xl" data-ogl-title>Prospects</h2>
          {prospects.map((c) => <ClientCard key={c.folder} c={c} open={tasksFor(c)} />)}
        </>
      )}
      <p className="font-mono text-[11px] text-muted-foreground">
        The build harness view lives at <Link href="/projects/harness" className="underline">Projects · harness</Link>. It is off until release clearance.
      </p>
    </div>
  );
}
