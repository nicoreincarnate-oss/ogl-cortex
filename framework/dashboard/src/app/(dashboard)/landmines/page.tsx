import { landmines, lastLandmineRun } from '@/lib/glitch/sources';
import { ProofHeader, Stat } from '@/components/proof/proof-header';
import { RunLandmines } from '@/components/proof/run-landmines';

export const dynamic = 'force-dynamic';

export default function LandminesPage() {
  const r = landmines();
  const run = lastLandmineRun();
  const fails = run?.lines.filter((l) => l.startsWith('FAIL')).length ?? 0;
  const passes = run?.lines.filter((l) => l.startsWith('PASS')).length ?? 0;
  return (
    <div className="space-y-6 p-4 md:p-8">
      <ProofHeader kicker="Proof · bug becomes a rule" title="Landmines" readAt={r.readAt} source="tools/landmines/LANDMINES.md" error={r.error}>
        Every bug we hit gets a numbered rule and a test that would catch it again. A bug is not fixed until it has a row here and a test in the run.
      </ProofHeader>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Rules" value={r.data?.length ?? 'none read'} />
        <Stat label="Tests passing" value={run ? passes : 'not run'} tone={run ? 'good' : undefined} />
        <Stat label="Tests failing" value={run ? fails : 'not run'} tone={run ? (fails ? 'bad' : 'good') : undefined} />
        <Stat label="Last run" value={run ? `${run.ranAt.slice(11, 16)} UTC` : 'never'} />
      </div>
      <RunLandmines />
      {run && run.exit !== 0 && fails === 0 && (
        <p className="border-2 border-destructive px-3 py-2 font-mono text-xs text-destructive">The test run exited {run.exit} without a FAIL line. Treat it as broken, not as a pass.</p>
      )}
      {run && (
        <ul className="grid gap-1 font-mono text-xs md:grid-cols-2">
          {run.lines.map((l, i) => (
            <li key={i} className={l.startsWith('FAIL') ? 'text-destructive' : ''}><span className={l.startsWith('FAIL') ? 'bg-destructive px-1 text-destructive-foreground' : 'bg-success px-1 text-success-foreground'}>{l.slice(0, 4)}</span> {l.slice(5)}</li>
          ))}
        </ul>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {r.data?.map((m) => (
          <article key={m.id} data-slot="card" className="space-y-2 rounded-md bg-card p-5">
            <div className="flex items-baseline gap-3">
              <span className="text-3xl leading-none text-primary" data-ogl-title>{m.id}</span>
              <span className="font-mono text-[11px] text-muted-foreground">{m.date}</span>
            </div>
            <p className="text-sm"><span className="font-mono text-[11px] uppercase text-muted-foreground">Bug · </span>{m.bug}</p>
            <p className="border-l-4 border-primary bg-muted px-3 py-2 text-sm font-medium"><span className="font-mono text-[11px] uppercase text-muted-foreground">Rule · </span>{m.rule}</p>
            <p className="font-mono text-[11px] text-muted-foreground">Test: {m.test}</p>
          </article>
        ))}
      </div>
    </div>
  );
}
