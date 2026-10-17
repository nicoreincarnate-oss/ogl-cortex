import { doneDrift } from '@/lib/glitch/sources';
import { ProofHeader, Stat } from '@/components/proof/proof-header';

export const dynamic = 'force-dynamic';

const ago = (min?: number) => (min === undefined ? '' : min < 60 ? `${min} min` : min < 2880 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} days`);

export default function DriftPage() {
  const r = doneDrift(7);
  const d = r.data;
  const changed = d?.rows.filter((x) => x.kind === 'changed') ?? [];
  const gone = d?.rows.filter((x) => x.kind === 'gone') ?? [];
  const tasksHit = new Set(d?.rows.map((x) => x.task.id)).size;
  return (
    <div className="space-y-6 p-4 md:p-8">
      <ProofHeader kicker="Proof · AgentTrail idea" title="Done drift" readAt={r.readAt} source="task files, last 7 days" error={r.error}>
        A task marked done names its files. If those files change after it closed, or are gone, the &ldquo;done&rdquo; is out of date.
        Each row is a task to reopen or re-check. Daily memory, logs and state files are left out because they change by design.
      </ProofHeader>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Done tasks, 7 days" value={d?.checked ?? 'none read'} />
        <Stat label="Name their files" value={d?.withPaths ?? 'none read'} />
        <Stat label="Changed after done" value={changed.length} tone={changed.length ? 'warn' : 'good'} />
        <Stat label="Files gone" value={gone.length} tone={gone.length ? 'bad' : 'good'} />
      </div>
      <p className="font-mono text-xs text-muted-foreground">{tasksHit} tasks have at least one row. Done tasks that name no files cannot be checked here.</p>
      <div data-slot="card" className="overflow-x-auto rounded-md bg-card">
        <table className="w-full text-sm">
          <thead className="bg-foreground text-left font-mono text-[11px] uppercase tracking-wider text-background">
            <tr><th className="px-3 py-2">What</th><th className="px-3 py-2">Task</th><th className="px-3 py-2">Seat</th><th className="px-3 py-2">Closed</th><th className="px-3 py-2">File</th></tr>
          </thead>
          <tbody>
            {d?.rows.map((x, i) => (
              <tr key={i} className="border-t border-foreground/20 align-top">
                <td className="whitespace-nowrap px-3 py-2">
                  {x.kind === 'gone'
                    ? <span className="bg-destructive px-2 py-0.5 font-mono text-[11px] uppercase text-destructive-foreground">Gone</span>
                    : <span className="bg-primary px-2 py-0.5 font-mono text-[11px] uppercase text-primary-foreground">+{ago(x.minutesAfter)}</span>}
                </td>
                <td className="max-w-md px-3 py-2"><p className="font-medium">{x.task.title}</p><p className="font-mono text-[11px] text-muted-foreground">{x.task.id}</p></td>
                <td className="px-3 py-2 font-mono text-xs">{x.task.assignee}</td>
                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{x.task.completed_at.replace('T', ' ').slice(0, 16)}</td>
                <td className="break-all px-3 py-2 font-mono text-xs">{x.path}</td>
              </tr>
            ))}
            {d && d.rows.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">No drift: every file a done task names is unchanged since it closed.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
