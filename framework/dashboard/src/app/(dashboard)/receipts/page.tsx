import { receipts } from '@/lib/glitch/sources';
import { ProofHeader, Stat } from '@/components/proof/proof-header';

export const dynamic = 'force-dynamic';

export default function ReceiptsPage() {
  const r = receipts(3);
  const rows = r.data ?? [];
  const missing = rows.filter((x) => x.exists === false).length;
  const ids = rows.filter((x) => x.exists === null).length;
  return (
    <div className="space-y-6 p-4 md:p-8">
      <ProofHeader kicker="Proof · a done carries its receipt" title="Receipts" readAt={r.readAt} source="every seat's daily memory, last 3 days" error={r.error}>
        Every &ldquo;done&rdquo; line ends with where the proof is. This page opens each receipt path. A receipt pointing at a file that does not exist is a claim with nothing behind it.
      </ProofHeader>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Receipts, 3 days" value={rows.length} />
        <Stat label="File found" value={rows.length - missing - ids} tone="good" />
        <Stat label="File missing" value={missing} tone={missing ? 'bad' : 'good'} />
        <Stat label="Ids, not files" value={ids} />
      </div>
      <div data-slot="card" className="overflow-x-auto rounded-md bg-card">
        <table className="w-full text-sm">
          <thead className="bg-foreground text-left font-mono text-[11px] uppercase tracking-wider text-background">
            <tr><th className="px-3 py-2">Proof</th><th className="px-3 py-2">Seat</th><th className="px-3 py-2">Day</th><th className="px-3 py-2">The line</th></tr>
          </thead>
          <tbody>
            {rows.map((x, i) => (
              <tr key={i} className="border-t border-foreground/20 align-top">
                <td className="px-3 py-2">
                  {x.exists === true && <span className="bg-success px-2 py-0.5 font-mono text-[11px] uppercase text-success-foreground">Found</span>}
                  {x.exists === false && <span className="bg-destructive px-2 py-0.5 font-mono text-[11px] uppercase text-destructive-foreground">Missing</span>}
                  {x.exists === null && <span className="bg-muted px-2 py-0.5 font-mono text-[11px] uppercase">Id only</span>}
                </td>
                <td className="px-3 py-2 font-mono text-xs">{x.agent}</td>
                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{x.day}</td>
                <td className="px-3 py-2 text-xs"><p>{x.line}</p><p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{x.path}</p></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
