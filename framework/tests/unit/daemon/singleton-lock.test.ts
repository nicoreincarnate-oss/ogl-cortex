import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  acquireDaemonSingleton,
  DaemonAlreadyRunningError,
  releaseDaemonSingleton,
} from '../../../src/daemon/singleton-lock.js';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'cortextos-daemon-singleton-'));
  roots.push(value);
  return value;
}

function absentPid(): number {
  for (const candidate of [2_000_000_000, 1_000_000_000, 9_999_999]) {
    try {
      process.kill(candidate, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return candidate;
    }
  }
  throw new Error('Unable to find an absent PID for stale-lock test');
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('daemon singleton ownership', () => {
  it('fails a duplicate live start before replacing the PID or lock', () => {
    const ctxRoot = root();
    const first = acquireDaemonSingleton(ctxRoot);
    const pidBefore = lstatSync(first.pidPath);
    const lockBefore = lstatSync(first.lockPath);

    expect(() => acquireDaemonSingleton(ctxRoot)).toThrowError(DaemonAlreadyRunningError);

    const pidAfter = lstatSync(first.pidPath);
    const lockAfter = lstatSync(first.lockPath);
    expect({ dev: pidAfter.dev, ino: pidAfter.ino }).toEqual({ dev: pidBefore.dev, ino: pidBefore.ino });
    expect({ dev: lockAfter.dev, ino: lockAfter.ino }).toEqual({ dev: lockBefore.dev, ino: lockBefore.ino });
    expect(readFileSync(first.pidPath, 'utf-8')).toBe(String(process.pid));

    expect(releaseDaemonSingleton(first)).toEqual({ pidRemoved: true, lockRemoved: true });
    expect(existsSync(first.pidPath)).toBe(false);
    expect(existsSync(first.lockPath)).toBe(false);
  });

  it('reclaims a tokenized stale lock and atomically replaces its stale PID file', () => {
    const ctxRoot = root();
    const lockPath = join(ctxRoot, 'daemon.lock');
    const pidPath = join(ctxRoot, 'daemon.pid');
    writeFileSync(lockPath, JSON.stringify({
      pid: absentPid(),
      token: 'stale-owner-token-00000000',
      acquired_at_ms: Date.now() - 60_000,
    }));
    writeFileSync(pidPath, '12345');

    const ownership = acquireDaemonSingleton(ctxRoot);

    expect(readFileSync(pidPath, 'utf-8')).toBe(String(process.pid));
    expect(JSON.parse(readFileSync(lockPath, 'utf-8'))).toMatchObject({
      pid: process.pid,
      token: ownership.token,
    });
    expect(releaseDaemonSingleton(ownership)).toEqual({ pidRemoved: true, lockRemoved: true });
  });

  it('does not delete a PID path replaced after startup', () => {
    const ctxRoot = root();
    const ownership = acquireDaemonSingleton(ctxRoot);
    const replacement = join(ctxRoot, 'foreign.pid');
    writeFileSync(replacement, 'foreign-owner');
    renameSync(replacement, ownership.pidPath);

    expect(releaseDaemonSingleton(ownership)).toEqual({
      pidRemoved: false,
      lockRemoved: true,
    });
    expect(readFileSync(ownership.pidPath, 'utf-8')).toBe('foreign-owner');
    expect(existsSync(ownership.lockPath)).toBe(false);
  });

  it('does not delete either path when the lock ownership token is replaced', () => {
    const ctxRoot = root();
    const ownership = acquireDaemonSingleton(ctxRoot);
    writeFileSync(ownership.lockPath, JSON.stringify({
      pid: process.pid,
      token: 'replacement-token-00000000',
      acquired_at_ms: Date.now(),
    }));

    expect(releaseDaemonSingleton(ownership)).toEqual({
      pidRemoved: false,
      lockRemoved: false,
    });
    expect(existsSync(ownership.pidPath)).toBe(true);
    expect(existsSync(ownership.lockPath)).toBe(true);
  });
});
