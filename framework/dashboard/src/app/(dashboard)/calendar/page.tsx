import { calendar, type CalEvent } from '@/lib/glitch/sources';
import { ProofHeader } from '@/components/proof/proof-header';
import { dayKey, dayLabel, clock, todayKey, TZ } from '@/components/proof/when';

export const dynamic = 'force-dynamic';

export default function CalendarPage() {
  const r = calendar();
  const events = r.data?.events ?? [];
  const failed = r.data?.accounts.filter((a) => !a.ok) ?? [];
  const days = new Map<string, CalEvent[]>();
  for (const e of events) {
    const k = e.all_day ? e.start : dayKey(e.start);
    days.set(k, [...(days.get(k) ?? []), e]);
  }
  const today = todayKey();
  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4 md:p-8">
      <ProofHeader kicker="Your week · read-only" title="Calendar" readAt={r.data?.read_at ?? r.readAt} source="Google Calendar: OGL + Gmail" error={r.error}>
        The next 7 days from your calendars, in {TZ} time. Tap an event to open it in Google Calendar.
      </ProofHeader>
      {failed.map((a) => (
        <p key={a.account} role="alert" className="border-2 border-destructive px-3 py-2 font-mono text-xs text-destructive">
          Could not read {a.account}, so its events are missing here: {a.error}
        </p>
      ))}
      {!r.error && events.length === 0 && failed.length === 0 && <p className="text-muted-foreground">Nothing on either calendar for the next 7 days.</p>}
      {[...days.entries()].map(([k, list]) => (
        <section key={k} className="space-y-2">
          <h2 className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            {k === today ? 'Today · ' : ''}{dayLabel(list[0].all_day ? `${k}T12:00:00-07:00` : list[0].start)}
          </h2>
          {list.map((e, i) => (
            <div key={i} data-slot="card" className="flex gap-4 rounded-md bg-card p-4">
              <div className="w-20 shrink-0">
                <p className="text-xl leading-none" data-ogl-title>{e.all_day ? 'All day' : clock(e.start)}</p>
                {!e.all_day && <p className="mt-1 font-mono text-[11px] text-muted-foreground">to {clock(e.end)}</p>}
              </div>
              <div className="min-w-0 flex-1">
                <a href={e.link} target="_blank" rel="noreferrer" className="font-semibold leading-snug underline-offset-4 hover:underline">{e.title}</a>
                <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                  {e.account}{e.people ? ` · ${e.people} people` : ''}{e.where ? ` · ${e.where}` : ''}
                </p>
                {e.meet && (
                  <a href={e.meet} target="_blank" rel="noreferrer" className="mt-3 inline-flex min-h-11 items-center border-2 border-foreground bg-primary px-4 font-mono text-xs uppercase text-primary-foreground shadow-[var(--ogl-shadow)]">
                    Join the Meet
                  </a>
                )}
              </div>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
