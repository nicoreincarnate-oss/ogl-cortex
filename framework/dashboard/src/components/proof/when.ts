// Times shown in the install's display timezone: CTX_TIMEZONE (an IANA name), passed to server and
// browser code by next.config.ts. Default UTC.
export const TZ = process.env.CTX_TIMEZONE || 'UTC';
export const dayKey = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });
export const dayLabel = (iso: string) => new Date(iso).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long', month: 'short', day: 'numeric' });
export const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
export const todayKey = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });

/** Epoch ms of the start of today in TZ. */
export function startOfToday(): number {
  const now = new Date();
  const asUtc = (tz: string) => new Date(now.toLocaleString('en-US', { timeZone: tz })).getTime();
  const offset = asUtc(TZ) - asUtc('UTC');
  return Math.floor((now.getTime() + offset) / 86400000) * 86400000 - offset;
}
