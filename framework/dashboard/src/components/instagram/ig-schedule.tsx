'use client';

import { useMemo, useState } from 'react';
import { dayKey, dayLabel, clock, todayKey } from '@/components/proof/when';
import type { IgCalendarPost } from '@/lib/data/ig-calendar';

const STATUS: Record<IgCalendarPost['status'], { label: string; cls: string }> = {
  posted: { label: 'Posted', cls: 'bg-success text-background' },
  scheduled: { label: 'Scheduled', cls: 'border-2 border-foreground bg-background text-foreground' },
  overdue: { label: 'Waiting', cls: 'bg-warning text-foreground' },
};

function monthCells(y: number, m: number) {
  const lead = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7; // Monday first
  const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const out: (string | null)[] = Array(lead).fill(null);
  for (let d = 1; d <= days; d++) out.push(`${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  while (out.length % 7) out.push(null);
  return out;
}

export function IgSchedule({ posts }: { posts: IgCalendarPost[] }) {
  const today = todayKey();
  const byDay = useMemo(() => {
    const m = new Map<string, IgCalendarPost[]>();
    for (const p of posts) m.set(dayKey(p.at), [...(m.get(dayKey(p.at)) ?? []), p]);
    return m;
  }, [posts]);
  const months = useMemo(() => {
    const keys = [...new Set([...byDay.keys()].map((k) => k.slice(0, 7)))].sort();
    return keys.map((k) => ({ key: k, y: Number(k.slice(0, 4)), m: Number(k.slice(5, 7)) - 1 }));
  }, [byDay]);
  const [monthIdx, setMonthIdx] = useState(() => Math.max(0, months.findIndex((x) => x.key === today.slice(0, 7))));
  const [open, setOpen] = useState<string | null>(null);
  const month = months[monthIdx];

  const jump = (k: string) => document.getElementById(`ig-${k}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div className="space-y-8">
      {month && (
        <section aria-label="Month" className="border-2 border-foreground bg-card p-3 shadow-[var(--ogl-shadow)]">
          <div className="mb-2 flex items-center justify-between">
            <button className="min-h-11 min-w-11 font-mono text-sm disabled:opacity-30" disabled={monthIdx === 0} onClick={() => setMonthIdx(monthIdx - 1)} aria-label="Previous month">←</button>
            <h2 className="font-mono text-xs uppercase tracking-widest">
              {new Date(Date.UTC(month.y, month.m, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}
            </h2>
            <button className="min-h-11 min-w-11 font-mono text-sm disabled:opacity-30" disabled={monthIdx === months.length - 1} onClick={() => setMonthIdx(monthIdx + 1)} aria-label="Next month">→</button>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center">
            {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
              <span key={i} className="font-mono text-[10px] text-muted-foreground">{d}</span>
            ))}
            {monthCells(month.y, month.m).map((k, i) => {
              const items = k ? byDay.get(k) ?? [] : [];
              const allPosted = items.length > 0 && items.every((p) => p.status === 'posted');
              return (
                <button
                  key={k ?? `pad-${i}`}
                  disabled={!items.length}
                  onClick={() => k && jump(k)}
                  className={`flex aspect-square flex-col items-center justify-center gap-0.5 text-sm ${k === today ? 'border-2 border-foreground' : ''} ${items.length ? 'font-semibold' : 'text-muted-foreground/60'}`}
                  aria-label={k ? `${k}: ${items.length} carousel${items.length === 1 ? '' : 's'}` : undefined}
                >
                  {k ? Number(k.slice(8)) : ''}
                  {items.length > 0 && (
                    <span className="flex gap-0.5">
                      {items.map((p) => (
                        <span key={p.dir} className={`h-1.5 w-1.5 ${allPosted || p.status === 'posted' ? 'bg-success' : p.status === 'overdue' ? 'bg-warning' : 'bg-primary'}`} />
                      ))}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {[...byDay.entries()].map(([k, list]) => (
        <section key={k} id={`ig-${k}`} className="scroll-mt-20 space-y-2">
          <h2 className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            {k === today ? 'Today · ' : ''}{dayLabel(list[0].at)}
          </h2>
          {list.map((p) => {
            const isOpen = open === p.dir;
            const first = p.caption.split('\n')[0];
            return (
              <div key={p.dir} data-slot="card" className="rounded-md bg-card">
                <button className="flex w-full gap-4 p-3 text-left" onClick={() => setOpen(isOpen ? null : p.dir)} aria-expanded={isOpen}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/ig-calendar/cover/${p.dir}`} alt="" loading="lazy" className="h-24 w-[77px] shrink-0 border-2 border-foreground object-cover" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <p className="text-xl leading-none" data-ogl-title>{clock(p.at)}</p>
                      <span className="font-mono text-[11px] text-muted-foreground">#{p.n}</span>
                    </div>
                    <span className={`mt-2 inline-block px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${STATUS[p.status].cls}`}>{STATUS[p.status].label}</span>
                    <p className="mt-2 line-clamp-2 text-sm leading-snug">{first}</p>
                  </div>
                </button>
                {isOpen && (
                  <div className="space-y-3 border-t-2 border-foreground p-3">
                    <p className="whitespace-pre-wrap text-sm leading-relaxed">{p.caption}</p>
                    <p className="font-mono text-[11px] text-muted-foreground">
                      {p.theme} theme · 6 clips · {p.postedAt ? `posted ${clock(p.postedAt)}` : `goes out ${clock(p.at)}`}
                    </p>
                    {p.permalink && (
                      <a href={p.permalink} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center border-2 border-foreground bg-primary px-4 font-mono text-xs uppercase text-primary-foreground shadow-[var(--ogl-shadow)]">
                        Open on Instagram
                      </a>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
