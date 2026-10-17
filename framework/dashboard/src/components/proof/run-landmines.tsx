'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

export function RunLandmines() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();
  return (
    <div className="flex items-center gap-3">
      <Button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          const res = await fetch('/api/proof/landmines', { method: 'POST' });
          if (!res.ok) setErr(`run failed: HTTP ${res.status}`);
          setBusy(false);
          router.refresh();
        }}
        className="border-2 border-foreground shadow-[var(--ogl-shadow)]"
      >
        {busy ? 'Running the tests…' : 'Run every landmine test now'}
      </Button>
      {err && <span className="font-mono text-xs text-destructive">{err}</span>}
    </div>
  );
}
