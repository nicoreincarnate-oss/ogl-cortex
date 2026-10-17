'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CrmNote } from '@/lib/data/crm-notes';

// Notes and follow-ups for one company. Adding one saves to the server and reloads the page data.
export function CompanyNotes({ company, notes, today }: { company: string; notes: CrmNote[]; today: string }) {
  const router = useRouter();
  const [text, setText] = useState('');
  const [followUp, setFollowUp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    setBusy(true);
    setError('');
    const res = await fetch('/api/crm/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company, text, followUp: followUp || null }),
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      setError((await res?.json().catch(() => null))?.error ?? 'Could not save. Try again.');
      return;
    }
    setText('');
    setFollowUp('');
    router.refresh();
  }

  async function toggle(id: string, done: boolean) {
    await fetch('/api/crm/notes', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company, id, done }),
    }).catch(() => null);
    router.refresh();
  }

  return (
    <div className="space-y-2 border-t border-border pt-2">
      {notes.map((n) => {
        const due = n.followUp && !n.done && n.followUp <= today;
        return (
          <div key={n.id} className="text-sm leading-snug">
            <p className={n.done ? 'text-muted-foreground line-through' : ''}>{n.text}</p>
            <p className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-[11px] text-muted-foreground">
              <span>{n.at.slice(0, 10)}</span>
              {n.followUp && (
                <>
                  <span className={due ? 'bg-primary px-1 text-primary-foreground' : ''}>follow up {n.followUp}</span>
                  <button onClick={() => toggle(n.id, !n.done)} className="underline">{n.done ? 'reopen' : 'done'}</button>
                </>
              )}
            </p>
          </div>
        );
      })}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        maxLength={2000}
        placeholder="Add a note"
        aria-label={`Note for ${company}`}
        className="w-full border-2 border-foreground bg-background px-3 py-2 text-sm"
      />
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 font-mono text-[11px] uppercase text-muted-foreground">
          Follow up
          <input type="date" value={followUp} onChange={(e) => setFollowUp(e.target.value)} className="border-2 border-foreground bg-background px-2 py-1 text-sm normal-case text-foreground" />
        </label>
        <button
          onClick={save}
          disabled={busy || !text.trim()}
          className="ml-auto border-2 border-foreground bg-foreground px-4 py-2 font-mono text-[11px] uppercase text-background disabled:opacity-40"
        >
          {busy ? 'Saving' : 'Save'}
        </button>
      </div>
      {error && <p role="alert" className="font-mono text-[11px] text-destructive">{error}</p>}
    </div>
  );
}
