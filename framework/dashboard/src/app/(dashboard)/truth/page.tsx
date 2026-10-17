import { fleetTruth } from '@/lib/glitch/sources';
import { ProofHeader, Stat } from '@/components/proof/proof-header';

export const dynamic = 'force-dynamic';

const VERDICT: Record<string, { label: string; tone: string; meaning: string }> = {
  consistent: { label: 'Consistent', tone: 'bg-success text-success-foreground', meaning: 'What it says matches what it did.' },
  'silent-but-alive': { label: 'Silent but alive', tone: 'bg-warning text-warning-foreground', meaning: 'Working, but its heartbeat is stale. The old dashboard shows it dark.' },
  'claimed-not-evidenced': { label: 'Claim, no evidence', tone: 'bg-destructive text-destructive-foreground', meaning: 'Says it is online, but its session has not written anything.' },
  dark: { label: 'Dark', tone: 'bg-foreground text-background', meaning: 'Nothing written and no event for over 6 hours.' },
};

const h = (v: number | null) => (v === null ? 'none' : v < 1 ? `${Math.round(v * 60)} min` : `${v.toFixed(1)} h`);

export default function TruthPage() {
  const r = fleetTruth();
  const seats = r.data ?? [];
  const bad = seats.filter((s) => s.verdict !== 'consistent').length;
  return (
    <div className="space-y-6 p-4 md:p-8">
      <ProofHeader kicker="Proof · no theater" title="Fleet truth" readAt={r.readAt} source="tools/fleet-truth" error={r.error}>
        A seat&apos;s heartbeat is something it types about itself. This page checks it against two things a seat cannot type:
        when its session last wrote, and its last event on the bus. Silence shows as silence.
      </ProofHeader>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <Stat label="Seats checked" value={seats.length} />
        <Stat label="Consistent" value={seats.length - bad} tone="good" />
        <Stat label="Need a look" value={bad} tone={bad ? 'bad' : 'good'} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {seats.map((s) => {
          const v = VERDICT[s.verdict] ?? { label: s.verdict, tone: 'bg-muted', meaning: '' };
          return (
            <article key={s.seat} data-slot="card" className="space-y-3 rounded-md bg-card p-5">
              <div className="flex items-center gap-3">
                <h2 className="text-2xl leading-none" data-ogl-title>{s.seat}</h2>
                <span className={`ml-auto px-2 py-1 font-mono text-[11px] uppercase tracking-wider ${v.tone}`}>{v.label}</span>
              </div>
              <p className="text-sm text-muted-foreground">{v.meaning}</p>
              <dl className="grid grid-cols-3 gap-2 font-mono text-xs">
                <div><dt className="text-muted-foreground">Heartbeat</dt><dd className="text-base">{h(s.heartbeat_age_h)}</dd></div>
                <div><dt className="text-muted-foreground">Session wrote</dt><dd className="text-base">{h(s.transcript_age_h)}</dd></div>
                <div><dt className="text-muted-foreground">Last event</dt><dd className="text-base">{h(s.last_event_age_h)}</dd></div>
              </dl>
              {s.claim && (
                <p className="border-l-4 border-primary bg-muted px-3 py-2 text-xs"><span className="font-mono uppercase text-muted-foreground">It says: </span>{s.claim}</p>
              )}
              {s.last_event && <p className="font-mono text-[11px] text-muted-foreground">last event: {s.last_event}</p>}
            </article>
          );
        })}
      </div>
    </div>
  );
}
