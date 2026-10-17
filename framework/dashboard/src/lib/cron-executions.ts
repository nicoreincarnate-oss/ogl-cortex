import fs from 'fs';
import path from 'path';
import { CTX_ROOT } from '@/lib/config';

export type StatusFilter = 'all' | 'success' | 'failure';

export interface CronExecutionLogEntry {
  ts: string;
  cron: string;
  status: 'fired' | 'retried' | 'failed';
  attempt: number;
  duration_ms: number;
  error: string | null;
}

export interface ExecutionLogPage {
  entries: CronExecutionLogEntry[];
  total: number;
  hasMore: boolean;
}

const CRONS_DIR = '.cortextOS/state/agents';
const VALID_AGENT = /^[a-zA-Z0-9_-]{1,128}$/;
const VALID_CRON = /^[a-zA-Z0-9_-]{1,128}$/;
export const CRON_EXECUTION_LOG_MAX_BYTES = 1024 * 1024;
export const CRON_EXECUTION_LINE_MAX_BYTES = 64 * 1024;

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string' || value.length > maxLength) return null;
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
}

function normalizeExecutionEntry(value: unknown): CronExecutionLogEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const ts = boundedString(entry.ts, 64);
  const cron = boundedString(entry.cron, 128);
  const status = entry.status;
  const attempt = entry.attempt;
  const durationMs = entry.duration_ms;
  const error = entry.error === null ? null : boundedString(entry.error, 4_096);
  if (!ts || !Number.isFinite(Date.parse(ts))) return null;
  if (!cron || !VALID_CRON.test(cron)) return null;
  if (status !== 'fired' && status !== 'retried' && status !== 'failed') return null;
  if (!Number.isSafeInteger(attempt) || (attempt as number) < 1 || (attempt as number) > 100) return null;
  if (!Number.isSafeInteger(durationMs) || (durationMs as number) < 0
    || (durationMs as number) > 7 * 24 * 60 * 60 * 1_000) return null;
  if (entry.error !== null && error === null) return null;
  return {
    ts,
    cron,
    status,
    attempt: attempt as number,
    duration_ms: durationMs as number,
    error,
  };
}

function readBoundedLog(logPath: string): string | null {
  let descriptor: number | null = null;
  try {
    const pathStats = fs.lstatSync(logPath);
    if (!pathStats.isFile() || pathStats.isSymbolicLink()) return null;
    descriptor = fs.openSync(
      logPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile() || stats.size <= 0) return '';
    const length = Math.min(stats.size, CRON_EXECUTION_LOG_MAX_BYTES);
    const start = Math.max(0, stats.size - length);
    const buffer = Buffer.allocUnsafe(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const count = fs.readSync(
        descriptor,
        buffer,
        bytesRead,
        length - bytesRead,
        start + bytesRead,
      );
      if (count === 0) break;
      bytesRead += count;
    }
    let raw = buffer.subarray(0, bytesRead).toString('utf-8');
    // A bounded tail may begin inside a line. Discard that incomplete line so
    // arbitrary prefixes are never interpreted as valid JSON.
    if (start > 0) {
      const firstNewline = raw.indexOf('\n');
      raw = firstNewline >= 0 ? raw.slice(firstNewline + 1) : '';
    }
    return raw;
  } catch {
    return null;
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* read-only close failure */ }
    }
  }
}

export function readExecutionLogPage(
  agentName: string,
  cronName: string | undefined,
  limit: number,
  offset: number,
  statusFilter: StatusFilter,
): ExecutionLogPage {
  if (!VALID_AGENT.test(agentName)) return { entries: [], total: 0, hasMore: false };
  if (cronName !== undefined && !VALID_CRON.test(cronName)) {
    return { entries: [], total: 0, hasMore: false };
  }
  const logPath = path.join(CTX_ROOT, CRONS_DIR, agentName, 'cron-execution.log');
  const raw = readBoundedLog(logPath);
  if (raw === null) return { entries: [], total: 0, hasMore: false };

  const allEntries: CronExecutionLogEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (Buffer.byteLength(trimmed, 'utf-8') > CRON_EXECUTION_LINE_MAX_BYTES) continue;
    try {
      const entry = normalizeExecutionEntry(JSON.parse(trimmed));
      if (entry) allEntries.push(entry);
    } catch {
      // Skip a malformed line while preserving the rest of the append-only log.
    }
  }

  let filtered = cronName
    ? allEntries.filter((entry) => entry.cron === cronName)
    : allEntries;

  if (statusFilter === 'success') {
    filtered = filtered.filter((entry) => entry.status === 'fired');
  } else if (statusFilter === 'failure') {
    filtered = filtered.filter((entry) => entry.status === 'failed');
  }

  const total = filtered.length;
  if (limit <= 0) {
    const safeOffset = Math.min(offset, total);
    return { entries: filtered.slice(0, total - safeOffset), total, hasMore: false };
  }

  const safeOffset = Math.max(0, Math.min(offset, total));
  const end = total - safeOffset;
  const start = Math.max(0, end - limit);
  return {
    entries: filtered.slice(start, end),
    total,
    hasMore: start > 0,
  };
}

export function entriesToCsv(entries: CronExecutionLogEntry[]): string {
  const header = 'timestamp,cron,status,attempt,duration_ms,error';
  const rows = entries.map((entry) => [
    entry.ts,
    entry.cron,
    entry.status,
    String(entry.attempt),
    String(entry.duration_ms),
    entry.error ?? '',
  ].map(csvEscape).join(','));
  return `${[header, ...rows].join('\n')}\n`;
}

function csvEscape(value: string): string {
  const formulaSafe = /^\s*[=+\-@]/.test(value) ? `'${value}` : value;
  if (/[",\n\r]/.test(formulaSafe)) return `"${formulaSafe.replace(/"/g, '""')}"`;
  return formulaSafe;
}
