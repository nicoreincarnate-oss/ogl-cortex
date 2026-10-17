import type { ReactNode } from 'react';

export function ProofHeader({ kicker, title, children, readAt, source, error }: {
  kicker: string;
  title: string;
  children?: ReactNode;
  readAt?: string;
  source?: string;
  error?: string;
}) {
  return (
    <header className="space-y-3 border-b-2 border-foreground pb-5">
      <p className="inline-block bg-foreground px-2 py-1 font-mono text-[11px] uppercase tracking-widest text-background">{kicker}</p>
      <h1 className="text-4xl leading-none md:text-5xl">{title}</h1>
      {children && <div className="max-w-2xl text-sm text-muted-foreground">{children}</div>}
      {(readAt || source) && (
        <p className="font-mono text-[11px] text-muted-foreground">
          {readAt && <>read {readAt.replace('T', ' ').slice(0, 19)} UTC</>}
          {source && <> · from {source}</>}
        </p>
      )}
      {error && (
        <p role="alert" className="border-2 border-destructive bg-destructive/10 px-3 py-2 font-mono text-xs text-destructive">
          This read failed, so nothing below is current: {error}
        </p>
      )}
    </header>
  );
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'bad' | 'good' | 'warn' }) {
  const color = tone === 'bad' ? 'text-destructive' : tone === 'good' ? 'text-success' : tone === 'warn' ? 'text-warning' : 'text-foreground';
  return (
    <div className="border-2 border-foreground bg-card px-4 py-3 shadow-[var(--ogl-shadow)]">
      <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</p>
      <p className={`mt-1 text-3xl leading-none ${color}`} data-ogl-title>{value}</p>
    </div>
  );
}
