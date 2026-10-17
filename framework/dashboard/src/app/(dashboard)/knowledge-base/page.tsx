import { getFrameworkRoot } from '@/lib/config';
import { KnowledgeBaseClient } from '@/components/knowledge-base/kb-client';
import { refreshMirror } from '@/lib/data/ogl-cortex';
import { STORES, listStore, searchMemory, lessonDescription, clientPromises, clientPromisesAt, type MemFile } from '@/lib/data/memory-stores';
import { getEntities, getCorrections, checkpointLines, kindOf, KIND_ORDER } from '@/lib/data/memory-hub';
import { defaultOrg, memorySeat } from '@/lib/install';
import Link from 'next/link';
import fs from 'fs';
import path from 'path';

function getKnowledgeContent(org: string): string {
  const frameworkRoot = getFrameworkRoot();
  const kbPath = path.join(frameworkRoot, 'orgs', org, 'knowledge.md');
  try {
    if (fs.existsSync(kbPath)) {
      return fs.readFileSync(kbPath, 'utf-8');
    }
  } catch {
    // graceful fallback
  }
  return '';
}

export const dynamic = 'force-dynamic';

const docHref = (store: string, rel: string) => `/knowledge-base/doc?store=${encodeURIComponent(store)}&path=${encodeURIComponent(rel)}`;
const browseHref = (store: string, dir?: string) => `/knowledge-base/browse?store=${encodeURIComponent(store)}${dir ? `&dir=${encodeURIComponent(dir)}` : ''}`;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const label = (id: string) => STORES.find((s) => s.id === id)?.label ?? id;
const plural = (n: number, w: string) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`;

function FileRow({ f, note }: { f: MemFile; note?: string }) {
  return (
    <li>
      <Link href={docHref(f.store, f.rel)} className="block py-2 hover:text-primary">
        <span className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate">{/^\d{4}-\d{2}-\d{2}$/.test(f.title) ? `Daily log ${f.title}` : f.title.replace(/-/g, ' ')}</span>
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{note ?? day(f.mtimeMs)}</span>
        </span>
      </Link>
    </li>
  );
}

function Panel({ kicker, title, sub, children }: { kicker: string; title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 border-2 border-foreground bg-card p-4 shadow-[var(--ogl-shadow)]">
      <div className="space-y-1">
        <p className="inline-block bg-foreground px-2 py-1 font-mono text-[11px] uppercase tracking-widest text-background">{kicker}</p>
        <h2 className="text-3xl leading-none" data-ogl-title>{title}</h2>
        {sub && <p className="text-sm text-muted-foreground">{sub}</p>}
      </div>
      {children}
    </section>
  );
}

// Our memory itself, all of it, organized for a person. Organized by what a thing is,
// not where it is stored: now, people and companies, projects, lessons, corrections, agents, records, then everything.
async function OurMemory({ q, scope }: { q: string; scope: string }) {
  refreshMirror();
  const lists = Object.fromEntries(STORES.map((s) => [s.id, listStore(s.id)]));
  const memoryIds = STORES.filter((s) => s.group !== 'blueprint').map((s) => s.id);
  const scopes: { id: string; label: string; ids: string[] }[] = [
    { id: 'all', label: 'Everything', ids: memoryIds },
    { id: 'brain', label: 'Brain notes', ids: ['brain'] },
    { id: 'agents', label: "Agents' notes", ids: STORES.filter((s) => s.group === 'seat').map((s) => s.id) },
    { id: 'lessons', label: 'Lessons', ids: STORES.filter((s) => s.group === 'lessons').map((s) => s.id) },
    { id: 'blueprint', label: 'Blueprint', ids: ['blueprint'] },
  ];
  const active = scopes.find((s) => s.id === scope) ?? scopes[0];
  const found = q ? await searchMemory(q, active.ids, 60) : null;
  const entities = getEntities();
  const matchedEntities = q ? entities.filter((e) => e.name.toLowerCase().includes(q.toLowerCase())) : [];
  const groups = found
    ? KIND_ORDER.map((k) => ({ kind: k, hits: found.hits.filter((h) => kindOf(h) === k) })).filter((g) => g.hits.length > 0)
    : [];

  const brain = lists['brain'] ?? [];
  const brainFolders = new Map<string, number>();
  for (const f of brain) {
    const top = f.rel.includes(path.sep) ? f.rel.split(path.sep)[0] : '';
    if (top) brainFolders.set(top, (brainFolders.get(top) ?? 0) + 1);
  }
  const brainLatest = brain[0];
  const projects = brain.filter((f) => kindOf(f) === 'Project').slice(0, 6);
  const seats = STORES.filter((s) => s.group === 'seat');
  const lessonStores = STORES.filter((s) => s.group === 'lessons' && lists[s.id].length > 0);
  const lessons = lessonStores.flatMap((s) => lists[s.id]).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const totalFiles = memoryIds.reduce((n, id) => n + lists[id].length, 0);
  const promises = clientPromises();
  const promisesAt = clientPromisesAt();
  const now = Date.now();
  const openPromises = (promises ?? []).filter((p) => !p.covered).sort((a, b) => a.due.localeCompare(b.due));
  const corrections = getCorrections();
  const checkpoint = checkpointLines();
  const people = entities.filter((e) => e.kind === 'Person');
  const companies = entities.filter((e) => e.kind === 'Company');
  const entityHref = (n: string) => `/knowledge-base/entity?name=${encodeURIComponent(n)}`;

  return (
    <div className="space-y-5">
      <form action="/knowledge-base" className="space-y-2">
        <div className="flex gap-2">
          <input
            name="q"
            defaultValue={q}
            placeholder="Search all our memory: a name, a client, a word"
            aria-label="Search all our memory"
            className="min-w-0 flex-1 border-2 border-foreground bg-background px-3 py-2 text-sm"
          />
          <button type="submit" className="border-2 border-foreground bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Search</button>
        </div>
        <fieldset className="flex flex-wrap gap-2 font-mono text-[11px]">
          <legend className="sr-only">Search in</legend>
          {scopes.map((s) => (
            <label key={s.id} className="flex cursor-pointer items-center gap-1 border border-foreground px-2 py-1 has-[:checked]:bg-foreground has-[:checked]:text-background">
              <input type="radio" name="in" value={s.id} defaultChecked={s.id === active.id} className="sr-only" />
              {s.label}
            </label>
          ))}
        </fieldset>
        <p className="font-mono text-[11px] text-muted-foreground">{totalFiles.toLocaleString('en-US')} memory files. Backups and old copies are left out.</p>
      </form>

      {found && (
        <section className="space-y-3" aria-label="Search results">
          <p className="font-mono text-[11px] text-muted-foreground">
            {found.total === 0 ? 'No file' : plural(found.total, 'file')} in {active.label.toLowerCase()} contain{found.total <= 1 ? 's' : ''} &ldquo;{q}&rdquo;{found.total > found.hits.length ? `, best ${found.hits.length} shown` : ''}.{' '}
            <Link href="/knowledge-base" className="underline">Clear</Link>
          </p>
          {matchedEntities.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {matchedEntities.map((e) => (
                <Link key={e.name} href={entityHref(e.name)} className="border-2 border-foreground bg-card px-3 py-1 text-sm hover:bg-muted">
                  {e.name} <span className="font-mono text-[10px] text-muted-foreground">{e.kind}</span>
                </Link>
              ))}
            </div>
          )}
          {groups.map((g) => (
            <div key={g.kind}>
              <h3 className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">{g.kind} ({g.hits.length})</h3>
              <ul className="divide-y divide-border">
                {g.hits.map((h) => (
                  <li key={h.store + h.rel} className="py-2">
                    <Link href={docHref(h.store, h.rel)} className="flex items-baseline justify-between gap-3 hover:text-primary">
                      <span className="min-w-0 truncate font-medium">{/^\d{4}-\d{2}-\d{2}$/.test(h.title) ? `Daily log ${h.title}` : h.title.replace(/-/g, ' ')}</span>
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{label(h.store).replace("'s lessons", '')} · {day(h.mtimeMs)}</span>
                    </Link>
                    {h.lines.map((l) => (
                      <p key={l.n} className="line-clamp-2 text-[13px] text-muted-foreground">{l.text}</p>
                    ))}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      <Panel kicker="Now" title="Where things stand" sub="Open promises, where the work is, and the last things we got wrong.">
        {checkpoint.current && (
          <div className="border-l-4 border-primary pl-3 text-sm">
            <p className="line-clamp-3">{checkpoint.current}</p>
            {checkpoint.next && <p className="mt-1 line-clamp-2 text-muted-foreground">Next: {checkpoint.next}</p>}
            <Link href={docHref(`seat:${memorySeat()}`, 'STATE.md')} className="font-mono text-[11px] underline">Full checkpoint</Link>
          </div>
        )}
        <h3 className="pt-1 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          Open promises to clients ({openPromises.length}; list last changed {promisesAt})
        </h3>
        <ul className="divide-y divide-border">
          {openPromises.map((p, i) => {
            const passed = Date.parse(p.due) < now;
            return (
              <li key={i} className="flex items-baseline justify-between gap-3 py-2 text-sm">
                <span className="min-w-0">{p.what} <span className="font-mono text-[11px] text-muted-foreground">{p.client}</span></span>
                <span className={`shrink-0 font-mono text-[11px] ${passed ? 'text-destructive' : 'text-muted-foreground'}`}>{p.due.slice(0, 10)}{passed ? ' passed' : ''}</span>
              </li>
            );
          })}
        </ul>
        <h3 className="pt-1 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">Last corrections</h3>
        <ul className="divide-y divide-border">
          {corrections.slice(0, 3).map((c, i) => (
            <li key={i} className="py-2 text-sm">
              <p className="line-clamp-2">{c.claim || c.correction}</p>
              <p className="font-mono text-[11px] text-muted-foreground">{c.agent}{c.by && c.by !== c.agent ? `, caught by ${c.by}` : ''} · {c.at.slice(0, 16).replace('T', ' ')}Z</p>
            </li>
          ))}
        </ul>
      </Panel>

      <section id="people">
        <Panel kicker="People & companies" title="Who we know" sub={`${people.length} people and ${companies.length} companies. Tap one for everything we have on them.`}>
          {[['People', people], ['Companies', companies]].map(([name, list]) => (
            <div key={name as string} className="space-y-1">
              <h3 className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">{name as string}</h3>
              <ul className="grid grid-cols-2 gap-2">
                {(list as typeof entities).map((e) => (
                  <li key={e.name}>
                    <Link href={entityHref(e.name)} className="block h-full border-2 border-foreground p-2 hover:bg-muted">
                      <span className="block truncate text-sm font-medium">{e.name}</span>
                      {e.line && <span className="line-clamp-2 block text-[11px] leading-snug text-muted-foreground">{e.line}</span>}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Panel>
      </section>

      <Panel kicker="Projects" title="What we worked on" sub={`${plural(brain.filter((f) => kindOf(f) === 'Project').length, 'project note')} in the brain. Client work itself is on the Projects tab.`}>
        <ul className="divide-y divide-border">
          {projects.map((f) => <FileRow key={f.rel} f={f} />)}
        </ul>
        <p className="flex flex-wrap gap-x-3 font-mono text-[11px]">
          <Link href={browseHref('brain', '03 Projects')} className="underline">All project notes</Link>
          <Link href="/projects" className="underline">Projects tab</Link>
        </p>
      </Panel>

      <Panel kicker="Lessons" title="What we learned" sub={`${plural(lessons.length, 'lesson')}, each from a real mistake or a rule you gave. Newest first.`}>
        <ul className="divide-y divide-border">
          {lessons.slice(0, 6).map((f) => {
            const store = STORES.find((s) => s.id === f.store)!;
            return (
              <li key={f.store + f.rel}>
                <Link href={docHref(f.store, f.rel)} className="block py-2 hover:text-primary">
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate font-medium">{f.title.replace(/-/g, ' ')}</span>
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{store.label.replace("'s lessons", '')} · {day(f.mtimeMs)}</span>
                  </span>
                  <span className="line-clamp-2 block text-xs text-muted-foreground">{lessonDescription(path.join(store.root, f.rel))}</span>
                </Link>
              </li>
            );
          })}
        </ul>
        <p className="flex flex-wrap gap-x-3 font-mono text-[11px]">
          {lessonStores.map((s) => <Link key={s.id} href={browseHref(s.id)} className="underline">All of {s.label} ({lists[s.id].length})</Link>)}
        </p>
      </Panel>

      <Panel kicker="Corrections" title="What we got wrong" sub={`${plural(corrections.length, 'correction')} on the ledger: what was said, and what was true.`}>
        <ul className="divide-y divide-border">
          {corrections.slice(3, 8).map((c, i) => (
            <li key={i} className="py-2 text-sm">
              <p className="line-clamp-2">{c.claim || c.correction}</p>
              {c.claim && c.correction && <p className="line-clamp-2 text-xs text-muted-foreground">True: {c.correction}</p>}
              <p className="font-mono text-[11px] text-muted-foreground">{c.agent}{c.by && c.by !== c.agent ? `, caught by ${c.by}` : ''} · {c.at.slice(0, 10)}</p>
            </li>
          ))}
        </ul>
        <Link href="/truth" className="inline-block font-mono text-[11px] underline">Corrections tab</Link>
      </Panel>

      <Panel kicker="The agents" title="Each agent's notebook" sub="Long-term memory, where the work stands, and every day's log.">
        <ul className="space-y-3">
          {seats.map((s) => {
            const files = lists[s.id];
            const daily = files.find((f) => /^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(f.rel));
            const has = (rel: string) => files.find((f) => f.rel === rel);
            const core = ['MEMORY.md', 'ENTITIES.md', 'STATE.md'].map(has).filter((f): f is MemFile => !!f);
            const handoffs = files.filter((f) => kindOf(f) === 'Handoff').length;
            return (
              <li key={s.id} className="border-2 border-foreground p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <Link href={browseHref(s.id)} className="text-xl font-medium hover:text-primary">{s.label}</Link>
                  <span className="font-mono text-[11px] text-muted-foreground">{plural(files.length, 'file')} · {handoffs} handoffs</span>
                </div>
                <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm">
                  {core.map((f) => <Link key={f.rel} href={docHref(s.id, f.rel)} className="underline">{kindOf(f)}</Link>)}
                  {daily && <Link href={docHref(s.id, daily.rel)} className="underline">Today&rsquo;s log</Link>}
                  <Link href={browseHref(s.id, 'memory')} className="underline">All logs</Link>
                </p>
              </li>
            );
          })}
        </ul>
      </Panel>

      <Panel kicker="Records" title="What happened" sub="The logs the agents keep as they work.">
        <ul className="grid grid-cols-2 gap-2 text-sm">
          {[
            ['/tasks', 'Tasks', 'every job, who has it, done or not'],
            ['/activity', 'Event log', 'what each agent did, as it happened'],
            ['/truth', 'Corrections', 'every time we got something wrong'],
            ['/receipts', 'Receipts', 'proof behind each claim'],
          ].map(([href, name, what]) => (
            <li key={href}>
              <Link href={href} className="block h-full border-2 border-foreground p-2 hover:bg-muted">
                <span className="font-medium">{name}</span>
                <span className="block text-xs text-muted-foreground">{what}</span>
              </Link>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel kicker="Everything" title="The whole brain" sub={`${plural(brain.length, 'note')} in the vault, the readable copy of GBrain. Last note written ${brainLatest ? day(brainLatest.mtimeMs) : 'never'}.`}>
        <ul className="grid grid-cols-2 gap-2">
          {[...brainFolders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, n]) => (
            <li key={name}>
              <Link href={browseHref('brain', name)} className="flex items-baseline justify-between gap-2 border-2 border-foreground p-2 hover:bg-muted">
                <span className="min-w-0 truncate text-sm font-medium">{name}</span>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{n}</span>
              </Link>
            </li>
          ))}
        </ul>
        <Link href={browseHref('brain')} className="inline-block font-mono text-[11px] underline">All {brainFolders.size} folders</Link>
        <p className="border-t border-border pt-3 text-sm">
          How the memory works is written up in the{' '}
          <Link href={docHref('blueprint', 'docs/05-memory-architecture.md')} className="underline">ogl-cortex blueprint</Link>{' '}
          (<Link href={browseHref('blueprint', 'docs')} className="underline">all {lists['blueprint'].filter((f) => f.rel.startsWith('docs/')).length} docs</Link>).
        </p>
      </Panel>
    </div>
  );
}

export default async function KnowledgeBasePage({ searchParams }: { searchParams: Promise<{ q?: string; in?: string }> }) {
  const sp = await searchParams;
  const q = (sp.q ?? '').trim().slice(0, 200);
  // CTX_ORG holds the fleet's knowledge base; else the first org
  const org = defaultOrg();
  const content = org ? getKnowledgeContent(org) : '';
  const kbPath = org
    ? path.join(getFrameworkRoot(), 'orgs', org, 'knowledge.md')
    : '';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Knowledge Base</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Everything we remember: people, promises, lessons, mistakes, and every agent's notes. Search it or tap in.
        </p>
      </div>

      <OurMemory q={q} scope={sp.in ?? 'all'} />

      <h2 className="pt-2 text-2xl" data-ogl-title>Ask the knowledge base</h2>
      <p className="-mt-4 text-sm text-muted-foreground">Ask in plain words. It matches meaning, not just the exact words.</p>
      <KnowledgeBaseClient
        org={org}
        markdownContent={content}
        filePath={kbPath}
      />
    </div>
  );
}
