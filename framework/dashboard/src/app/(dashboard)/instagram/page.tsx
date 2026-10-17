import { readIgCalendar } from '@/lib/data/ig-calendar';
import { ProofHeader, Stat } from '@/components/proof/proof-header';
import { IgSchedule } from '@/components/instagram/ig-schedule';
import { TZ } from '@/components/proof/when';

export const dynamic = 'force-dynamic';

export default function InstagramPage() {
  const snap = readIgCalendar();
  const posted = snap.posts.filter((p) => p.status === 'posted').length;
  const waiting = snap.posts.filter((p) => p.status === 'overdue').length;
  const last = snap.posts.at(-1);
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 md:p-8">
      <ProofHeader
        kicker="Instagram · posting schedule"
        title="Instagram"
        readAt={new Date().toISOString()}
        source="poster/schedule.json + posted.jsonl"
        error={snap.error ?? undefined}
      >
        Every carousel for @{snap.account}, in {TZ} time. Tap a day to jump to it, tap a carousel to read its caption.
      </ProofHeader>
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Posted" value={posted} tone={posted ? 'good' : undefined} />
        <Stat label="Scheduled" value={snap.posts.length - posted - waiting} />
        <Stat label="Waiting" value={waiting} tone={waiting ? 'warn' : undefined} />
      </div>
      {last && (
        <p className="font-mono text-[11px] text-muted-foreground">
          {snap.posts.length} carousels · 1 a day, then 2, then 3 · last one {new Date(last.at).toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric' })}
        </p>
      )}
      <IgSchedule posts={snap.posts} />
    </div>
  );
}
