// Web push to the operator's phone (the installed Cortex OS app). VAPID keys and subscriptions live in
// CTX_ROOT/config (mode 600). Keys are made once on first use and never leave this machine.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import webpush from 'web-push';
import { CTX_ROOT } from '@/lib/config';
import { PUSH_CONTACT } from '@/lib/install';

const DIR = path.join(CTX_ROOT, 'config');
const KEYS = path.join(DIR, 'webpush-vapid.json');
const SUBS = path.join(DIR, 'webpush-subs.json');

function writeAtomic(file: string, data: unknown) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function vapidKeys(): { publicKey: string; privateKey: string } {
  try {
    return JSON.parse(fs.readFileSync(KEYS, 'utf8'));
  } catch {
    const keys = webpush.generateVAPIDKeys();
    writeAtomic(KEYS, keys);
    return keys;
  }
}

export interface StoredSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  device: string;
  added: string;
}

export function readSubs(): StoredSub[] {
  try {
    return JSON.parse(fs.readFileSync(SUBS, 'utf8'));
  } catch {
    return [];
  }
}

export function saveSub(sub: { endpoint: string; keys: { p256dh: string; auth: string } }, device: string) {
  const subs = readSubs().filter((s) => s.endpoint !== sub.endpoint);
  subs.push({ endpoint: sub.endpoint, keys: sub.keys, device, added: new Date().toISOString() });
  writeAtomic(SUBS, subs);
}

export interface PushMessage {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

/** Sends to every subscribed device. Drops subscriptions the push service says are gone (404/410). */
export async function sendPush(msg: PushMessage): Promise<{ sent: number; failed: number; removed: number }> {
  const { publicKey, privateKey } = vapidKeys();
  webpush.setVapidDetails(PUSH_CONTACT, publicKey, privateKey);
  const subs = readSubs();
  let sent = 0, failed = 0;
  const gone = new Set<string>();
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(msg), { TTL: 3600 });
        sent++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) gone.add(s.endpoint);
        else failed++;
      }
    }),
  );
  if (gone.size) writeAtomic(SUBS, subs.filter((s) => !gone.has(s.endpoint)));
  return { sent, failed, removed: gone.size };
}
