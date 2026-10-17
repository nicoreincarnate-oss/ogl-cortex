'use client';

import { useEffect, useState } from 'react';

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// "Turn on alerts": registers the service worker, asks the phone for permission, sends the subscription
// to the server, then fires one test alert so the operator sees what they look like.
export function AlertsToggle() {
  const [state, setState] = useState<'checking' | 'off' | 'on' | 'blocked' | 'unsupported' | 'working'>('checking');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return setState('unsupported');
    if (Notification.permission === 'denied') return setState('blocked');
    navigator.serviceWorker.register('/sw.js').then(async (reg) => {
      setState((await reg.pushManager.getSubscription()) ? 'on' : 'off');
    }).catch(() => setState('unsupported'));
  }, []);

  async function turnOn() {
    setState('working');
    setNote('');
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      if ((await Notification.requestPermission()) !== 'granted') return setState('blocked');
      const { publicKey } = await (await fetch('/api/push/key')).json();
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) }));
      const res = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON(), device: navigator.userAgent }),
      });
      if (!res.ok) throw new Error('save failed');
      await fetch('/api/push/test', { method: 'POST' });
      setState('on');
      setNote('A test alert is on its way.');
    } catch {
      setState('off');
      setNote('That did not work. Try again.');
    }
  }

  if (state === 'checking' || state === 'unsupported') return null;
  return (
    <div className="flex flex-wrap items-center gap-3 border-2 border-foreground bg-card p-3">
      <p className="min-w-0 flex-1 text-sm">
        {state === 'on' && 'Alerts are on for this phone.'}
        {state === 'off' && 'Get an alert on this phone when something needs you.'}
        {state === 'working' && 'Turning alerts on…'}
        {state === 'blocked' && 'Alerts are blocked. Allow them in Chrome site settings for this app, then reload.'}
        {note && <span className="block font-mono text-[11px] text-muted-foreground">{note}</span>}
      </p>
      {state === 'off' && (
        <button onClick={turnOn} className="border-2 border-foreground bg-primary px-4 py-2 font-mono text-[11px] uppercase text-primary-foreground">
          Turn on alerts
        </button>
      )}
      {state === 'on' && (
        <button onClick={() => fetch('/api/push/test', { method: 'POST' })} className="border-2 border-foreground px-3 py-2 font-mono text-[11px] uppercase">
          Send a test
        </button>
      )}
    </div>
  );
}
