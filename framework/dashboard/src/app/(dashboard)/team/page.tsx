import { team, type TeamTask } from '@/lib/glitch/team';
import { calendar } from '@/lib/glitch/sources';
import { ProofHeader } from '@/components/proof/proof-header';
import { clock, dayKey, todayKey, TZ } from '@/components/proof/when';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

function Line({ t }: { t: TeamTask }) {
  return (
    <li className="py-2">
      <p className="leading-snug">{t.plain ?? t.title}</p>
      <details className="mt-1">
        <summary className="cursor-pointer font-mono text-[11px] text-muted-foreground">{t.plain ? 'the task behind this' : 'plain version on its way'}</summary>
        <p className="mt-1 break-words font-mono text-[11px] text-muted-foreground">{t.title} · {t.id}</p>
      </details>
    </li>
  );
}

const pulse = (min: number | null) =>
  min === null ? { text: 'no heartbeat on file', tone: 'bg-muted' }
  : min <= 90 ? { text: `checked in ${min} min ago`, tone: 'bg-success text-success-foreground' }
  : { text: `quiet for ${Math.round(min / 60)} h`, tone: 'bg-warning text-warning-foreground' };

export default function TeamPage() {
  const { seats, readAt } = team();
  const cal = calendar();
  const today = todayKey();
  const next = (cal.data?.events ?? []).filter((e) => !e.all_day && dayKey(e.start) === today && Date.parse(e.end) > Date.now()).slice(0, 3);
  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4 md:p-8">
      <ProofHeader kicker="Who does what" title="Team" readAt={readAt} source="task files + heartbeats">
        Each seat&apos;s job in one line, what it is working on now and what it finished today (your day, {TZ} time).
      </ProofHeader>

      <section data-slot="card" className="rounded-md bg-foreground p-4 text-background">
        <div className="flex items-baseline justify-between">
          <h2 className="text-2xl leading-none" data-ogl-title>Today for you</h2>
          <Link href="/calendar" className="font-mono text-[11px] uppercase text-primary">full week</Link>
        </div>
        {cal.error && <p className="mt-2 font-mono text-xs text-primary">Calendar read failed: {cal.error}</p>}
        {!cal.error && next.length === 0 && <p className="mt-2 text-sm opacity-80">Nothing else on your calendars today.</p>}
        <ul className="mt-2 space-y-2">
          {next.map((e, i) => (
            <li key={i} className="flex items-center gap-3">
              <span className="w-16 shrink-0 font-mono text-sm text-primary">{clock(e.start)}</span>
              <span className="min-w-0 flex-1 truncate">{e.title}</span>
              {e.meet && <a href={e.meet} target="_blank" rel="noreferrer" className="shrink-0 bg-primary px-3 py-2 font-mono text-[11px] uppercase text-primary-foreground">Join</a>}
            </li>
          ))}
        </ul>
      </section>

      {seats.map((s) => {
        const p = pulse(s.heartbeatAgeMin);
        return (
          <article key={s.name} data-slot="card" className="space-y-3 rounded-md bg-card p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-3xl leading-none" data-ogl-title>{s.label}</h2>
              <span className={`ml-auto px-2 py-1 font-mono text-[10px] uppercase tracking-wider ${p.tone}`}>{p.text}</span>
            </div>
            <p className="border-l-4 border-primary pl-3 text-sm font-medium">{s.job}</p>
            <div>
              <h3 className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">Working on now ({s.now.length})</h3>
              {s.now.length === 0 ? <p className="py-2 text-sm text-muted-foreground">Nothing open.</p> : <ul className="divide-y divide-foreground/15">{s.now.slice(0, 6).map((t) => <Line key={t.id} t={t} />)}</ul>}
              {s.now.length > 6 && <p className="font-mono text-[11px] text-muted-foreground">+{s.now.length - 6} more on the Tasks page</p>}
            </div>
            <div>
              <h3 className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">Finished today ({s.doneToday.length})</h3>
              {s.doneToday.length === 0 ? <p className="py-2 text-sm text-muted-foreground">Nothing finished yet today.</p> : <ul className="divide-y divide-foreground/15">{s.doneToday.slice(0, 6).map((t) => <Line key={t.id} t={t} />)}</ul>}
            </div>
            {s.stuck > 0 && <p className="font-mono text-[11px] text-warning">{s.stuck} tasks blocked, waiting on someone</p>}
          </article>
        );
      })}
    </div>
  );
}
