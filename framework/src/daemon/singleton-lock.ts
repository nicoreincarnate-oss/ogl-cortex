import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { ensureDir } from '../utils/atomic.js';

const LOCK_RECORD_MAX_BYTES = 4_096;
const LOCK_INITIALIZATION_GRACE_MS = 5_000;
const ACQUIRE_ATTEMPTS = 5;

interface FileIdentity {
  dev: number;
  ino: number;
}

interface LockRecord {
  pid: number;
  token: string;
  acquired_at_ms: number;
}

interface FileSnapshot {
  identity: FileIdentity;
  isFile: boolean;
  mtimeMs: number;
  size: number;
  content?: string;
}

interface LockInspection {
  state: 'missing' | 'live' | 'initializing' | 'stale';
  identity?: FileIdentity;
  record?: LockRecord;
}

export interface DaemonSingletonOwnership {
  lockPath: string;
  pidPath: string;
  pid: number;
  token: string;
  lockIdentity: FileIdentity;
  pidIdentity: FileIdentity;
}

export interface DaemonSingletonReleaseResult {
  pidRemoved: boolean;
  lockRemoved: boolean;
}

export class DaemonAlreadyRunningError extends Error {
  readonly code = 'EALREADY';
  readonly existingPid?: number;

  constructor(message: string, existingPid?: number) {
    super(message);
    this.name = 'DaemonAlreadyRunningError';
    this.existingPid = existingPid;
  }
}

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function snapshotPath(path: string, includeContent = false): FileSnapshot | null {
  let fd: number | undefined;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    fd = openSync(path, constants.O_RDONLY | noFollow);
    const stats = fstatSync(fd);
    const snapshot: FileSnapshot = {
      identity: { dev: stats.dev, ino: stats.ino },
      isFile: stats.isFile(),
      mtimeMs: stats.mtimeMs,
      size: stats.size,
    };
    if (includeContent && snapshot.isFile && snapshot.size <= LOCK_RECORD_MAX_BYTES) {
      snapshot.content = readFileSync(fd, 'utf-8');
    }
    return snapshot;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;

    // O_NOFOLLOW rejects symbolic links with ELOOP. Capture only their own
    // identity/mtime; never follow them while deciding whether they are stale.
    if (code === 'ELOOP') {
      try {
        const stats = lstatSync(path);
        return {
          identity: { dev: stats.dev, ino: stats.ino },
          isFile: false,
          mtimeMs: stats.mtimeMs,
          size: stats.size,
        };
      } catch (lstatError) {
        if ((lstatError as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw lstatError;
      }
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseLockRecord(content: string | undefined): LockRecord | null {
  if (content === undefined) return null;
  try {
    const parsed = JSON.parse(content) as Partial<LockRecord>;
    if (!Number.isSafeInteger(parsed.pid) || (parsed.pid ?? 0) <= 0) return null;
    if (typeof parsed.token !== 'string' || parsed.token.length < 16 || parsed.token.length > 100) {
      return null;
    }
    if (!Number.isSafeInteger(parsed.acquired_at_ms) || (parsed.acquired_at_ms ?? 0) <= 0) {
      return null;
    }
    return parsed as LockRecord;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM proves that a process exists but is owned by another principal.
    // Any unfamiliar error fails closed; only ESRCH proves the PID is absent.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function inspectLock(path: string): LockInspection {
  const snapshot = snapshotPath(path, true);
  if (!snapshot) return { state: 'missing' };

  const recent = Date.now() - snapshot.mtimeMs < LOCK_INITIALIZATION_GRACE_MS;
  if (!snapshot.isFile || snapshot.size > LOCK_RECORD_MAX_BYTES) {
    return {
      state: recent ? 'initializing' : 'stale',
      identity: snapshot.identity,
    };
  }

  const record = parseLockRecord(snapshot.content);
  if (!record) {
    return {
      state: recent ? 'initializing' : 'stale',
      identity: snapshot.identity,
    };
  }

  return {
    state: processIsAlive(record.pid) ? 'live' : 'stale',
    identity: snapshot.identity,
    record,
  };
}

function unlinkObserved(path: string, identity: FileIdentity): boolean {
  let current;
  try {
    current = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (!sameIdentity(identity, { dev: current.dev, ino: current.ino })) return false;
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function createExclusiveRecord(path: string, record: LockRecord): FileIdentity {
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  let fd: number | undefined;
  let identity: FileIdentity | undefined;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
    const stats = fstatSync(fd);
    identity = { dev: stats.dev, ino: stats.ino };
    writeFileSync(fd, JSON.stringify(record), 'utf-8');
    fsyncSync(fd);
    return identity;
  } catch (error) {
    if (identity) {
      try { unlinkObserved(path, identity); } catch { /* retain original error */ }
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function releaseRecord(path: string, pid: number, token: string, identity: FileIdentity): boolean {
  const snapshot = snapshotPath(path, true);
  if (!snapshot || !sameIdentity(snapshot.identity, identity)) return false;
  const record = parseLockRecord(snapshot.content);
  if (!record || record.pid !== pid || record.token !== token) return false;
  return unlinkObserved(path, identity);
}

function acquireRecoveryMutex(lockPath: string, token: string): () => void {
  const mutexPath = `${lockPath}.reclaim`;
  const record: LockRecord = { pid: process.pid, token, acquired_at_ms: Date.now() };

  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
    try {
      const identity = createExclusiveRecord(mutexPath, record);
      return () => {
        try { releaseRecord(mutexPath, record.pid, record.token, identity); } catch { /* best effort */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    const observed = inspectLock(mutexPath);
    if (observed.state === 'missing') continue;
    if (observed.state === 'live' || observed.state === 'initializing') {
      throw new DaemonAlreadyRunningError('Daemon singleton recovery is already in progress');
    }
    if (observed.identity) unlinkObserved(mutexPath, observed.identity);
  }

  throw new DaemonAlreadyRunningError('Unable to acquire the daemon singleton recovery mutex');
}

function createPidFile(pidPath: string, pid: number, token: string): FileIdentity {
  const tempPath = `${pidPath}.${token}.tmp`;
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  let fd: number | undefined;
  let identity: FileIdentity | undefined;
  let renamed = false;
  try {
    fd = openSync(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
    const stats = fstatSync(fd);
    identity = { dev: stats.dev, ino: stats.ino };
    writeFileSync(fd, String(pid), 'utf-8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, pidPath);
    renamed = true;

    const installed = snapshotPath(pidPath, true);
    if (!installed || !sameIdentity(installed.identity, identity)
      || installed.content?.trim() !== String(pid)) {
      throw new Error('Unable to prove ownership of the installed daemon PID file');
    }
    return identity;
  } catch (error) {
    if (identity) {
      const candidatePath = renamed ? pidPath : tempPath;
      try { unlinkObserved(candidatePath, identity); } catch { /* retain original error */ }
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function lockIsOwned(ownership: DaemonSingletonOwnership): boolean {
  const snapshot = snapshotPath(ownership.lockPath, true);
  if (!snapshot || !sameIdentity(snapshot.identity, ownership.lockIdentity)) return false;
  const record = parseLockRecord(snapshot.content);
  return record?.pid === ownership.pid && record.token === ownership.token;
}

/**
 * Acquire exclusive daemon ownership before creating the PID file, IPC socket,
 * harness scheduler, or agent manager. A live/initializing owner fails closed;
 * stale recovery is serialized by a second ownership-token-checked lock.
 */
export function acquireDaemonSingleton(
  ctxRoot: string,
  pid = process.pid,
): DaemonSingletonOwnership {
  ensureDir(ctxRoot);
  const lockPath = join(ctxRoot, 'daemon.lock');
  const pidPath = join(ctxRoot, 'daemon.pid');
  const token = randomUUID();
  const record: LockRecord = { pid, token, acquired_at_ms: Date.now() };
  let lockIdentity: FileIdentity | undefined;

  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS && !lockIdentity; attempt += 1) {
    try {
      lockIdentity = createExclusiveRecord(lockPath, record);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    const observed = inspectLock(lockPath);
    if (observed.state === 'missing') continue;
    if (observed.state === 'live') {
      throw new DaemonAlreadyRunningError(
        `cortextOS daemon is already running (pid ${observed.record?.pid ?? 'unknown'})`,
        observed.record?.pid,
      );
    }
    if (observed.state === 'initializing') {
      throw new DaemonAlreadyRunningError('cortextOS daemon ownership is being initialized');
    }

    const releaseMutex = acquireRecoveryMutex(lockPath, token);
    try {
      const current = inspectLock(lockPath);
      if (current.state === 'live') {
        throw new DaemonAlreadyRunningError(
          `cortextOS daemon is already running (pid ${current.record?.pid ?? 'unknown'})`,
          current.record?.pid,
        );
      }
      if (current.state === 'initializing') {
        throw new DaemonAlreadyRunningError('cortextOS daemon ownership is being initialized');
      }
      if (current.state === 'stale' && current.identity) {
        unlinkObserved(lockPath, current.identity);
      }
      try {
        lockIdentity = createExclusiveRecord(lockPath, record);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    } finally {
      releaseMutex();
    }
  }

  if (!lockIdentity) {
    throw new DaemonAlreadyRunningError('Unable to acquire exclusive cortextOS daemon ownership');
  }

  try {
    const pidIdentity = createPidFile(pidPath, pid, token);
    return { lockPath, pidPath, pid, token, lockIdentity, pidIdentity };
  } catch (error) {
    try { releaseRecord(lockPath, pid, token, lockIdentity); } catch { /* retain original error */ }
    throw error;
  }
}

/**
 * Remove only the exact PID and lock files created by this owner. If either
 * path has been replaced or its token/content no longer matches, it is left in
 * place for explicit stale recovery by a future daemon.
 */
export function releaseDaemonSingleton(
  ownership: DaemonSingletonOwnership,
): DaemonSingletonReleaseResult {
  let pidRemoved = false;
  let lockRemoved = false;

  // The PID file has no token for compatibility with existing tooling, so the
  // still-owned tokenized singleton lock is part of its ownership proof.
  if (lockIsOwned(ownership)) {
    const pidSnapshot = snapshotPath(ownership.pidPath, true);
    if (pidSnapshot
      && sameIdentity(pidSnapshot.identity, ownership.pidIdentity)
      && pidSnapshot.content?.trim() === String(ownership.pid)) {
      pidRemoved = unlinkObserved(ownership.pidPath, ownership.pidIdentity);
    }
  }

  if (lockIsOwned(ownership)) {
    lockRemoved = releaseRecord(
      ownership.lockPath,
      ownership.pid,
      ownership.token,
      ownership.lockIdentity,
    );
  }

  return { pidRemoved, lockRemoved };
}
