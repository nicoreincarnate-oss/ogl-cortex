import Link from 'next/link';
import { ProofHeader } from '@/components/proof/proof-header';
import { getCrm, type Stage } from '@/lib/data/crm';
import { getTasks } from '@/lib/data/tasks';
import { readNotes } from '@/lib/data/crm-notes';
import { CompanyNotes } from '@/components/crm/company-notes';
import { todayKey } from '@/components/proof/when';

export const dynamic = 'force-dynamic';

const STAGES: Stage[] = ['Client', 'Prospect', 'Lead'];
const PLURAL: Record<Stage, string> = { Client: 'Clients', Prospect: 'Prospects', Lead: 'Grader leads' };

export default async function CrmPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const stage = STAGES.find((s) => s === params.stage);
  const q = typeof params.q === 'string' ? params.q.trim().toLowerCase() : '';
  const { companies, counts, error } = getCrm();
  const notes = readNotes();
  const today = todayKey();
  const open = getTasks().filter((t) => ['pending', 'in_progress', 'blocked'].includes(t.status as string));
  const shown = companies.filter(
    (c) =>
      (!stage || c.stage === stage) &&
      (!q || [c.name, c.detail, ...c.people.map((p) => `${p.name} ${p.emails.join(' ')}`)].join(' ').toLowerCase().includes(q)),
  );
  const chip = (label: string, href: string, on: boolean) => (
    <Link
      href={href}
      className={`border-2 border-foreground px-3 py-2 font-mono text-[11px] uppercase ${on ? 'bg-foreground text-background' : 'bg-card'}`}
    >
      {label}
    </Link>
  );
  return (
    <div className="mx-auto max-w-2xl space-y-5 p-4 md:p-8">
      <ProofHeader kicker="Who we work with" title="CRM" readAt={new Date().toISOString()} source="client folders, lead watch, ENTITIES.md" error={error}>
        Every client, prospect and grader lead, with the people we know there and their open work.
      </ProofHeader>
      <div className="flex flex-wrap gap-2">
        {chip(`All ${companies.length}`, '/crm', !stage)}
        {STAGES.map((s) => chip(`${PLURAL[s]} ${counts[s]}`, `/crm?stage=${s}`, stage === s))}
      </div>
      <form action="/crm" className="flex gap-2">
        {stage && <input type="hidden" name="stage" value={stage} />}
        <input
          name="q"
          defaultValue={q}
          placeholder="Search a name, person or email"
          className="min-w-0 flex-1 border-2 border-foreground bg-card px-3 py-2 text-sm"
        />
        <button className="border-2 border-foreground bg-primary px-4 font-mono text-[11px] uppercase text-primary-foreground">Find</button>
      </form>
      {shown.length === 0 && <p className="text-sm text-muted-foreground">Nothing matches.</p>}
      {shown.map((c) => {
        const tasks = open.filter((t) => c.keys.some((k) => t.title.toLowerCase().includes(k)));
        return (
          <article key={`${c.stage}-${c.name}`} data-slot="card" className="space-y-2 rounded-md bg-card p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="break-all text-2xl leading-none" data-ogl-title>{c.name}</h2>
              <span className={`px-2 py-1 font-mono text-[11px] uppercase ${c.stage === 'Client' ? 'bg-primary text-primary-foreground' : 'bg-foreground text-background'}`}>{c.stage}</span>
            </div>
            <p className="font-mono text-[11px] text-muted-foreground">
              {c.lastTouch ? `last touch ${c.lastTouch}` : 'no date on file'}
              {c.files > 0 && <> · <Link href="/projects" className="underline">{c.files} files</Link></>}
              {tasks.length > 0 && <> · {tasks.length} open task{tasks.length === 1 ? '' : 's'}</>}
            </p>
            {c.detail && <p className="text-sm leading-snug">{c.detail}</p>}
            {c.people.length > 0 && (
              <ul className="space-y-2 border-t border-border pt-2">
                {c.people.map((p) => (
                  <li key={p.name} className="text-sm leading-snug">
                    <span className="font-medium">{p.name}</span>
                    {p.note && <span className="text-muted-foreground">, {p.note}</span>}
                    {(p.emails.length > 0 || p.phones.length > 0) && (
                      <span className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                        {p.emails.map((e) => <a key={e} href={`mailto:${e}`} className="font-mono text-[11px] text-primary underline">{e}</a>)}
                        {p.phones.map((ph) => <a key={ph} href={`tel:${ph.replace(/[\s-]/g, '')}`} className="font-mono text-[11px] text-primary underline">{ph}</a>)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <CompanyNotes company={c.name} notes={notes[c.name] ?? []} today={today} />
            <p className="font-mono text-[10px] text-muted-foreground">from {c.source}</p>
          </article>
        );
      })}
    </div>
  );
}
