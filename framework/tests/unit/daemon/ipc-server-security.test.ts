import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConnection } from 'net';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import {
  IPC_MAX_REQUEST_BYTES,
  IPCServer,
} from '../../../src/daemon/ipc-server.js';
import { getIpcPath } from '../../../src/utils/paths.js';
import type { AgentManager } from '../../../src/daemon/agent-manager.js';
import type { HarnessService } from '../../../src/harness/service.js';
import type { IPCResponse } from '../../../src/types/index.js';

const servers: IPCServer[] = [];
const roots: string[] = [];

function instance(): string {
  const id = `ipc-security-${randomUUID().slice(0, 8)}`;
  const root = join(homedir(), '.cortextos', id);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return id;
}

function manager(): AgentManager {
  return {
    getAllStatuses: () => ({ sentinel: 'first-server' }),
    getAgentNames: () => [],
  } as unknown as AgentManager;
}

function rawRequest(instanceId: string, chunks: Array<string | Buffer>): Promise<IPCResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(getIpcPath(instanceId), () => {
      for (const chunk of chunks) socket.write(chunk);
    });
    let response = '';
    socket.on('data', (chunk) => { response += chunk.toString('utf8'); });
    socket.on('end', () => {
      try { resolve(JSON.parse(response) as IPCResponse); }
      catch { reject(new Error(`Invalid IPC response: ${response}`)); }
    });
    socket.on('error', reject);
    socket.setTimeout(10_000, () => {
      socket.destroy();
      reject(new Error('raw IPC test timed out'));
    });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  while (servers.length) servers.pop()!.stop();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('IPC server security boundary', () => {
  it('does not unlink or replace a responsive server socket', async () => {
    const id = instance();
    const first = new IPCServer(manager(), id);
    servers.push(first);
    await first.start();

    const second = new IPCServer(manager(), id);
    await expect(second.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    second.stop();

    const response = await rawRequest(id, ['{"type":"status"}']);
    expect(response).toMatchObject({
      success: true,
      data: { sentinel: 'first-server' },
    });
  });

  it('refuses to delete a non-socket path at the IPC address', async () => {
    const id = instance();
    const socketPath = getIpcPath(id);
    writeFileSync(socketPath, 'operator-data');
    const server = new IPCServer(manager(), id);

    await expect(server.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(existsSync(socketPath)).toBe(true);
    expect(readFileSync(socketPath, 'utf8')).toBe('operator-data');
  });

  it('accepts a fragmented legacy JSON-object request', async () => {
    const id = instance();
    const server = new IPCServer(manager(), id);
    servers.push(server);
    await server.start();

    const response = await rawRequest(id, ['{"type":', '"status",', '"source":"test"}']);
    expect(response.success).toBe(true);
  });

  it.each([
    ['null primitive', ['null']],
    ['array envelope', ['[]']],
    ['non-object data', ['{"type":"status","data":[]}']],
    ['concatenated objects', ['{"type":"status"}{"type":"status"}']],
  ])('rejects %s with a structured response', async (_label, chunks) => {
    const id = instance();
    const server = new IPCServer(manager(), id);
    servers.push(server);
    await server.start();

    const response = await rawRequest(id, chunks);
    expect(response).toMatchObject({ success: false, code: 'INVALID_INPUT' });
  });

  it('rejects a request larger than the byte budget', async () => {
    const id = instance();
    const server = new IPCServer(manager(), id);
    servers.push(server);
    await server.start();

    const oversized = `{"type":"status","source":"${'a'.repeat(IPC_MAX_REQUEST_BYTES)}"}`;
    const response = await rawRequest(id, [oversized]);
    expect(response).toMatchObject({ success: false, code: 'INVALID_INPUT' });
    expect(response.error).toMatch(/exceeds/i);
  });

  it('returns a stable correlated error without exposing internal harness failures', async () => {
    const id = instance();
    const internalMessage = '/private/operator/path api_token=do-not-return';
    const harness = {
      handle: () => { throw new Error(internalMessage); },
    } as unknown as HarnessService;
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const server = new IPCServer(manager(), id, harness);
    servers.push(server);
    await server.start();

    const response = await rawRequest(id, [
      '{"type":"harness","data":{"action":"status"}}',
    ]);

    expect(response).toMatchObject({
      success: false,
      error: 'Internal IPC request failure',
      code: 'INTERNAL_ERROR',
      data: { correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/) },
    });
    expect(JSON.stringify(response)).not.toContain(internalMessage);
    const correlationId = (response.data as { correlationId: string }).correlationId;
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining(`correlation=${correlationId}`),
      expect.any(Error),
    );
  });

  it('does not reflect an unknown command string in the public response', async () => {
    const id = instance();
    const server = new IPCServer(manager(), id);
    servers.push(server);
    await server.start();

    const response = await rawRequest(id, ['{"type":"private-command-name"}']);

    expect(response).toMatchObject({
      success: false,
      error: 'Unknown IPC command',
      code: 'INVALID_INPUT',
    });
    expect(JSON.stringify(response)).not.toContain('private-command-name');
  });
});
