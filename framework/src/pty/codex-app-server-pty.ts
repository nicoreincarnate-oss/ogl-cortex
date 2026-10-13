import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';
import type { AgentConfig, CtxEnv } from '../types/index.js';
import { OutputBuffer } from './output-buffer.js';
import type { TelegramAPI } from '../telegram/api.js';
import { ensureDir, atomicWriteSync } from '../utils/atomic.js';
import { resolvePaths } from '../utils/paths.js';
import { logEvent } from '../bus/event.js';
import { WsUnixJsonRpcClient, type JsonRpcResponse } from '../utils/ws-unix-client.js';

interface IPty {
  pid: number;
  write(data: string): void;
  onData(callback: (data: string) => void): { dispose(): void };
  onExit(callback: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  kill(signal?: string): void;
}

interface IPtySpawnOptions {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
}

type SpawnFn = (file: string, args: string[], options: IPtySpawnOptions) => IPty;

interface ThreadState {
  threadId: string;
  cwd: string;
  updatedAt: string;
}

interface SocketPointer {
  socketPath: string;
  fallback: boolean;
  reason?: string;
  updatedAt: string;
}

interface ThreadResponse {
  thread: {
    id: string;
    status?: unknown;
  };
}

interface SkillsListResponse {
  data?: Array<{
    cwd: string;
    skills: Array<{
      name: string;
      path: string;
      scope?: string;
      enabled?: boolean;
    }>;
  }>;
}

interface GoalResponse {
  goal: {
    objective?: string | null;
    status?: string | null;
  } | null;
}

interface TurnResponse {
  turn?: {
    id: string;
    items?: unknown[];
    status?: unknown;
  };
}

interface DurableTurn {
  id: string;
  input: unknown[];
  enqueuedAt: string;
}

interface DurableTurnQueue {
  version: 1;
  items: DurableTurn[];
}

interface TurnCompletion {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  recoveryTimer: ReturnType<typeof setTimeout> | null;
  recovering: boolean;
}

interface ParsedTelegramEnvelope {
  mediaType: string | null;
  chatId: string;
  beforeReply: string;
}

interface ParsedTelegramBundle {
  envelopes: ParsedTelegramEnvelope[];
  trailing: string;
}

interface TelegramExtraction {
  payload: string;
  replyDirective: string | null;
  trailingContent?: string;
  compound?: boolean;
}

const THREAD_PERMISSION_OVERRIDES = {
  approvalPolicy: 'never',
  sandbox: 'workspace-write',
} as const;

const TURN_PERMISSION_OVERRIDES = {
  approvalPolicy: 'never',
  sandboxPolicy: { type: 'workspaceWrite' },
} as const;

const SOCKET_BASENAME = 'codex.sock';
const SOCKET_PATH_WARN_BYTES = 100;
const BOOTSTRAP_PATTERN = '[codex-app-server] ready';
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_TURN_INTERRUPT_GRACE_MS = 30 * 1000;

const SLASH_REWRITE_RE = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i;
const LOCAL_SLASH_COMMANDS = new Set(['goal']);

/**
 * Codex app-server PTY adapter for cortextOS.
 *
 * Uses a persistent `codex app-server` process and speaks JSON-RPC over the
 * app-server's WebSocket-framed Unix socket transport. The approved default
 * socket is `$CTX_ROOT/state/<agent>/codex.sock`; if that resolved path is
 * longer than the conservative 100-byte Unix socket threshold, the adapter
 * falls back to `/tmp/cas-<short-uuid>.sock` and writes a state-dir pointer.
 */
export class CodexAppServerPTY {
  private _alive = false;
  private _executing = false;
  private _activeTurnId: string | null = null;
  private _writeBuffer = '';
  private _turnQueue: DurableTurn[] = [];
  private _turnCompletion: TurnCompletion | null = null;
  private _spawnFn: SpawnFn | null = null;
  private _appServerPty: IPty | null = null;
  private _rpc: WsUnixJsonRpcClient | null = null;
  private _onExitHandler: ((exitCode: number, signal?: number) => void) | null = null;
  private _outputBuffer: OutputBuffer;
  private _env: CtxEnv;
  private _config: AgentConfig;
  private _stateDir: string;
  private _cwd: string;
  private _socketPath: string;
  private _socketListenArg: string;
  private _socketCwd: string;
  private _threadStatePath: string;
  private _socketPointerPath: string;
  private _turnQueuePath: string;
  private _threadId: string | null = null;
  private _telegramApi: TelegramAPI | null = null;
  private _chatId: string | null = null;
  private _typingLastSent = 0;

  constructor(env: CtxEnv, config: AgentConfig, logPath?: string) {
    this._env = env;
    this._config = config;
    this._cwd = config.working_directory || env.agentDir || process.cwd();
    this._stateDir = join(env.ctxRoot, 'state', env.agentName);
    this._threadStatePath = join(this._stateDir, 'codex-app-server-thread.json');
    this._socketPointerPath = join(this._stateDir, 'codex-app-server-socket.json');
    this._turnQueuePath = join(this._stateDir, 'codex-app-server-turn-queue.json');
    const socket = this.resolveSocketPath();
    this._socketPath = socket.path;
    this._socketListenArg = socket.listenArg;
    this._socketCwd = socket.cwd;
    this._outputBuffer = new OutputBuffer(1000, logPath, BOOTSTRAP_PATTERN);
    this._turnQueue = this.readTurnQueue();
  }

  async spawn(mode: 'fresh' | 'continue', prompt: string): Promise<void> {
    if (this._alive) {
      throw new Error('CodexAppServerPTY already spawned. Kill first.');
    }

    ensureDir(this._stateDir);
    this._alive = true;

    try {
      await this.startAppServerWithRetry();
      await this.connectRpc();
      await this.initializeRpc();
      await this.startOrResumeThread(mode);
      await this.reconcilePersistedTurnQueue();
      this._outputBuffer.push(`${BOOTSTRAP_PATTERN} thread=${this._threadId}\n`);
      if (this._turnQueue.length > 0) {
        this.drainQueue().catch((err) => {
          this._outputBuffer.push(`[codex-app-server] restored turn queue failed: ${err}\n`);
        });
      }
      if (prompt.trim()) {
        this.queueTurn([{ type: 'text', text: prompt, text_elements: [] }]);
      }
    } catch (err) {
      this._alive = false;
      this._outputBuffer.push(`[codex-app-server] degraded: ${err}\n`);
      this.kill();
      throw err;
    }
  }

  write(data: string): void {
    if (!this._alive) return;

    if (data === '\r') {
      const content = this._writeBuffer
        .replace(/\x1b\[200~/g, '')
        .replace(/\x1b\[201~/g, '')
        .trim();
      this._writeBuffer = '';
      if (content) {
        this.handleInput(content).catch((err) => {
          this._outputBuffer.push(`[codex-app-server] input failed: ${err}\n`);
        });
      }
    } else {
      this._writeBuffer += data;
    }
  }

  kill(): void {
    this._alive = false;
    this._activeTurnId = null;
    this._turnQueue = [];
    this.rejectTurnCompletion(new Error('Codex app-server stopped'));
    if (this._rpc) {
      this._rpc.close();
      this._rpc = null;
    }
    if (this._appServerPty) {
      try {
        this._appServerPty.kill();
      } catch {
        // Ignore shutdown errors.
      }
      this._appServerPty = null;
    }
    this.removeSocket();
    this._onExitHandler?.(0, undefined);
    this._onExitHandler = null;
  }

  isAlive(): boolean {
    return this._alive;
  }

  getPid(): number | null {
    return this._appServerPty?.pid ?? null;
  }

  onExit(handler: (exitCode: number, signal?: number) => void): void {
    this._onExitHandler = handler;
  }

  getOutputBuffer(): OutputBuffer {
    return this._outputBuffer;
  }

  setTelegramHandle(api: TelegramAPI, chatId: string): void {
    this._telegramApi = api;
    this._chatId = chatId;
  }

  private async handleInput(content: string): Promise<void> {
    const extracted = this.extractTelegramPayload(content);
    const input = extracted?.payload ?? content;
    // Native slash/skill handlers consume one logical input. A compound
    // Telegram bundle must remain one visible turn; otherwise a command in its
    // first envelope could swallow every later photo or inbox message.
    const allowLocalRouting = !extracted?.compound;
    const goalCommand = allowLocalRouting ? this.parseGoalCommand(input) : null;
    if (goalCommand?.type === 'get') {
      await this.getGoal();
      return;
    }
    if (goalCommand?.type === 'clear') {
      await this.clearGoal();
      return;
    }
    if (goalCommand?.type === 'set') {
      await this.setGoal(goalCommand.objective);
      return;
    }
    if (allowLocalRouting && input.startsWith('$')) {
      await this.handleSkillInput(input);
      return;
    }
    const slashMatch = allowLocalRouting ? input.match(SLASH_REWRITE_RE) : null;
    if (slashMatch && !LOCAL_SLASH_COMMANDS.has(slashMatch[1].toLowerCase())) {
      const [, name, trailing] = slashMatch;
      const trimmed = trailing?.trim();
      const rewritten = trimmed ? `$${name} ${trimmed}` : `$${name}`;
      await this.handleSkillInput(rewritten);
      return;
    }
    const telegramTurn = extracted?.replyDirective
      ? `${input}\n\n${extracted.replyDirective}`
      : input;
    // Keep a trailing AGENT MESSAGE envelope after the Telegram reply
    // directive so its own msg_id/body/send-message footer remain adjacent and
    // cannot be hidden behind a later Telegram-only routing instruction.
    const turnText = extracted?.trailingContent
      ? `${telegramTurn}\n\n${extracted.trailingContent}`
      : telegramTurn;
    this.queueTurn([{ type: 'text', text: turnText, text_elements: [] }]);
  }

  private extractTelegramPayload(content: string): TelegramExtraction | null {
    if (!content.startsWith('=== TELEGRAM')) return null;

    const bundle = this.parseTelegramBundle(content);
    // A malformed or chat-id-mismatched bundle is safer left byte-exact than
    // partially extracted: handleInput will give Codex every original envelope
    // and every original reply directive instead of silently routing them all
    // to the first chat.
    if (!bundle) return null;

    const chatIds = new Set(bundle.envelopes.map((envelope) => envelope.chatId));
    if (chatIds.size !== 1) {
      return {
        payload: content,
        replyDirective: null,
        compound: true,
      };
    }

    const payloads = bundle.envelopes
      .map((envelope) => this.extractSingleTelegramPayload(envelope))
      .filter((payload): payload is string => Boolean(payload));

    // FastChecker may append agent-inbox envelopes after Telegram content in
    // the same injection. Preserve that tail verbatim so success-gated inbox
    // ACKs never discard a message Codex did not actually receive.
    if (payloads.length === 0) return null;

    const [chatId] = chatIds;
    return {
      payload: payloads.join('\n\n'),
      replyDirective: `Reply via: cortextos bus send-telegram ${chatId} '<your reply>' — this is the only path that surfaces in Telegram and on the dashboard. Do not reply through the codex channel.`,
      trailingContent: bundle.trailing || undefined,
      compound: bundle.envelopes.length > 1 || Boolean(bundle.trailing),
    };
  }

  /**
   * Segment the daemon's concatenated Telegram envelope grammar. Boundaries
   * are recognized only outside the dynamically-sized fences produced by
   * wrapFenceSafe, so captions/transcripts can safely contain header or reply
   * marker text without creating or truncating an envelope.
   */
  private parseTelegramBundle(content: string): ParsedTelegramBundle | null {
    const envelopes: ParsedTelegramEnvelope[] = [];
    let cursor = 0;

    while (cursor < content.length) {
      const headerEnd = content.indexOf('\n', cursor);
      const headerStop = headerEnd === -1 ? content.length : headerEnd;
      const header = content.slice(cursor, headerStop).replace(/\r$/, '');
      const headerMatch = header.match(
        /^=== TELEGRAM(?:\s+(PHOTO|DOCUMENT|VOICE|AUDIO|VIDEO|VIDEO_NOTE))?\s+from\b.*\(chat_id:(-?\d+)\)\s+===$/,
      );

      if (!headerMatch) {
        return envelopes.length > 0
          ? { envelopes, trailing: content.slice(cursor) }
          : null;
      }

      const mediaType = headerMatch[1] ?? null;
      const chatId = headerMatch[2];
      let lineStart = headerEnd === -1 ? content.length : headerEnd + 1;
      let activeFence: string | null = null;
      let foundReply = false;

      while (lineStart <= content.length) {
        const newline = content.indexOf('\n', lineStart);
        const lineEnd = newline === -1 ? content.length : newline;
        const line = content.slice(lineStart, lineEnd).replace(/\r$/, '');

        if (activeFence) {
          if (line === activeFence) activeFence = null;
        } else {
          const fenceMatch = line.match(/^(`{3,})(?:[a-zA-Z0-9_-]+)?$/);
          if (fenceMatch) {
            activeFence = fenceMatch[1];
          } else {
            const replyMatch = line.match(
              /^Reply using: cortextos bus send-telegram (-?\d+) '<your reply>'\s*$/,
            );
            if (replyMatch) {
              if (replyMatch[1] !== chatId) return null;
              envelopes.push({
                mediaType,
                chatId,
                beforeReply: this.stripTrailingTelegramContext(
                  content.slice(cursor, lineStart).trimEnd(),
                ),
              });
              cursor = newline === -1 ? content.length : newline + 1;
              while (cursor < content.length && (content[cursor] === '\n' || content[cursor] === '\r')) {
                cursor += 1;
              }
              foundReply = true;
              break;
            }
          }
        }

        if (newline === -1) break;
        lineStart = newline + 1;
      }

      if (!foundReply) return null;
      if (cursor >= content.length) break;

      const nextEnd = content.indexOf('\n', cursor);
      const nextStop = nextEnd === -1 ? content.length : nextEnd;
      const nextLine = content.slice(cursor, nextStop).replace(/\r$/, '');
      if (!nextLine.startsWith('=== TELEGRAM')) {
        return { envelopes, trailing: content.slice(cursor) };
      }
    }

    return { envelopes, trailing: '' };
  }

  private stripTrailingTelegramContext(beforeReply: string): string {
    let cursor = 0;
    let activeFence: string | null = null;
    while (cursor <= beforeReply.length) {
      const newline = beforeReply.indexOf('\n', cursor);
      const lineEnd = newline === -1 ? beforeReply.length : newline;
      const line = beforeReply.slice(cursor, lineEnd).replace(/\r$/, '');

      if (activeFence) {
        if (line === activeFence) activeFence = null;
      } else {
        const fenceMatch = line.match(/^(`{3,})(?:[a-zA-Z0-9_-]+)?$/);
        if (fenceMatch) {
          activeFence = fenceMatch[1];
        } else if (line.startsWith('[Your last message:')) {
          return beforeReply.slice(0, cursor).trimEnd();
        }
      }

      if (newline === -1) break;
      cursor = newline + 1;
    }
    return beforeReply;
  }

  private extractSingleTelegramPayload(envelope: ParsedTelegramEnvelope): string | null {
    const { mediaType, beforeReply } = envelope;
    const replyToContext = this.extractReplyToContext(beforeReply);
    const wrap = (payload: string | null): string | null => {
      if (!payload) return null;
      return replyToContext ? `${payload}\n\n${replyToContext}` : payload;
    };

    if (mediaType) {
      const mediaPayload = this.buildMediaPayload(mediaType, beforeReply);
      if (mediaPayload) return wrap(mediaPayload);
    }

    const lines = beforeReply
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (line.startsWith('=== TELEGRAM')) continue;
      if (line.startsWith('[Recent conversation:]')) continue;
      if (line.startsWith('[reply_to:')) continue;
      if (line.startsWith('[Replying to:')) continue;
      if (line.startsWith('/') || line.startsWith('$')) return wrap(line);
      break;
    }

    const fencedBlocks = [...beforeReply.matchAll(/```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)\n```/g)];
    if (fencedBlocks.length > 0) {
      return wrap(fencedBlocks[fencedBlocks.length - 1]?.[1]?.trim() || null);
    }

    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (line.startsWith('=== TELEGRAM')) continue;
      if (line.startsWith('[Recent conversation:]')) continue;
      if (line.startsWith('[reply_to:')) continue;
      if (line.startsWith('[Replying to:')) continue;
      return wrap(line);
    }

    return null;
  }

  private buildMediaPayload(mediaType: string, beforeReply: string): string | null {
    // Match a dynamically-sized fence (3+ backticks): wrapFenceSafe grows the
    // fence to outlast any backtick run in the body, so the close must be the
    // same length as the open (backreference \1). Group 2 is the body.
    const captionMatch = beforeReply.match(/caption:\s*\n(`{3,})(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)\n\1/);
    const caption = captionMatch?.[2]?.trim() ?? '';

    const transcriptMatch = beforeReply.match(/transcript:\s*\n(`{3,})(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)\n\1/);
    const transcript = transcriptMatch?.[2]?.trim() ?? '';

    const localFileMatch = beforeReply.match(/^local_file:\s*(.+)$/m);
    const localFile = localFileMatch?.[1]?.trim() ?? '';

    const fileNameMatch = beforeReply.match(/^file_name:\s*(.+)$/m);
    const fileName = fileNameMatch?.[1]?.trim() ?? '';

    const durationMatch = beforeReply.match(/^duration:\s*(.+)$/m);
    const duration = durationMatch?.[1]?.trim() ?? '';

    const lines: string[] = [`[${mediaType}]`];
    if (caption) lines.push(`caption: ${caption}`);
    if (transcript) lines.push(`transcript: ${transcript}`);
    if (fileName) lines.push(`file_name: ${fileName}`);
    if (localFile) lines.push(`local_file: ${localFile}`);
    if (duration) lines.push(`duration: ${duration}`);

    return lines.length > 1 ? lines.join('\n') : null;
  }

  private extractReplyToContext(beforeReply: string): string | null {
    const telegramReplyMatch = beforeReply.match(/\[Replying to:\s*"([\s\S]*?)"\]/);
    if (telegramReplyMatch) {
      const text = telegramReplyMatch[1].slice(0, 200);
      if (text) return `[in reply to: ${text}]`;
    }

    const replyToMatch = beforeReply.match(/\[reply_to:\s*(\d+)\]/);
    if (!replyToMatch) return null;
    const messageId = replyToMatch[1];

    try {
      const outboundLog = join(this._stateDir, 'outbound-messages.jsonl');
      if (!existsSync(outboundLog)) return `[in reply to message ${messageId}]`;
      const fileLines = readFileSync(outboundLog, 'utf-8').split('\n').filter((l) => l.trim());
      for (let i = fileLines.length - 1; i >= 0; i -= 1) {
        try {
          const entry = JSON.parse(fileLines[i]) as { message_id?: number | string; text?: string };
          if (entry.message_id !== undefined && String(entry.message_id) === messageId) {
            const text = (entry.text || '').slice(0, 200);
            return text ? `[in reply to: ${text}]` : `[in reply to message ${messageId}]`;
          }
        } catch {
          // skip malformed lines
        }
      }
      return `[in reply to message ${messageId}]`;
    } catch {
      return `[in reply to message ${messageId}]`;
    }
  }

  private parseGoalCommand(content: string): { type: 'get' | 'clear' } | { type: 'set'; objective: string } | null {
    const match = content.trim().match(/^\/goal(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/i);
    if (!match) return null;

    const objective = match[1]?.trim();
    if (!objective) return { type: 'get' };
    if (objective.toLowerCase() === 'clear') return { type: 'clear' };
    return { type: 'set', objective };
  }

  private async startAppServerWithRetry(): Promise<void> {
    const delays = [1000, 4000, 16000];
    let lastErr: unknown;

    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      try {
        this.removeSocket();
        await this.startAppServer();
        return;
      } catch (err) {
        lastErr = err;
        this.cleanupSpawnAttempt();
        this._outputBuffer.push(`[codex-app-server] spawn attempt ${attempt + 1} failed: ${err}\n`);
        if (attempt < delays.length - 1) {
          await sleep(delays[attempt]);
        }
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private startAppServer(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this._spawnFn) {
        const nodePty = require('node-pty');
        this._spawnFn = nodePty.spawn;
      }

      const spawnFn = this._spawnFn!;
      const pty = spawnFn('codex', [
        'app-server',
        '--enable', 'goals',
        '--listen', this._socketListenArg,
      ], {
        name: 'xterm-256color',
        cols: 200,
        rows: 50,
        cwd: this._socketCwd,
        env: this.buildEnv(),
      });

      this._appServerPty = pty;
      pty.onData((data) => {
        this._outputBuffer.push(data);
        if (data.includes('Error:')) {
          reject(new Error(data.trim()));
        }
      });
      pty.onExit(({ exitCode, signal }) => {
        if (this._appServerPty !== pty) return;
        this._appServerPty = null;
        this._alive = false;
        this.rejectTurnCompletion(new Error('Codex app-server exited'));
        this._onExitHandler?.(exitCode, signal);
      });

      this.waitForSocket().then(resolve, reject);
    });
  }

  private async waitForSocket(timeoutMs = 10000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (existsSync(this._socketPath)) return;
      await sleep(100);
    }
    throw new Error(`Timed out waiting for app-server socket: ${this._socketPath}`);
  }

  private async connectRpc(): Promise<void> {
    this._rpc = new WsUnixJsonRpcClient(this._socketPath);
    this._rpc.onMessage((message) => this.handleRpcMessage(message));
    await this._rpc.connect();
  }

  private async initializeRpc(): Promise<void> {
    await this.request('initialize', {
      clientInfo: {
        name: 'cortextos',
        title: 'cortextOS',
        version: this.getPackageVersion(),
      },
      capabilities: { experimentalApi: true },
    });
    this._rpc?.notify('initialized');
  }

  private async startOrResumeThread(mode: 'fresh' | 'continue'): Promise<void> {
    if (mode === 'continue') {
      const persisted = this.readThreadState();
      if (persisted) {
        try {
          const resumed = await this.request<ThreadResponse>('thread/resume', {
            threadId: persisted.threadId,
            cwd: this._cwd,
            ...THREAD_PERMISSION_OVERRIDES,
            config: { features: { goals: true } },
            excludeTurns: true,
            persistExtendedHistory: true,
          });
          this.setThreadId(resumed.result?.thread.id || persisted.threadId);
          return;
        } catch (err) {
          this._outputBuffer.push(`[codex-app-server] persisted resume failed: ${err}\n`);
        }
      }

      const latest = await this.findLatestThreadForCwd();
      if (latest) {
        const resumed = await this.request<ThreadResponse>('thread/resume', {
          threadId: latest,
          cwd: this._cwd,
          ...THREAD_PERMISSION_OVERRIDES,
          config: { features: { goals: true } },
          excludeTurns: true,
          persistExtendedHistory: true,
        });
        this.setThreadId(resumed.result?.thread.id || latest);
        return;
      }
    }

    const started = await this.request<ThreadResponse>('thread/start', {
      cwd: this._cwd,
      ...THREAD_PERMISSION_OVERRIDES,
      config: { features: { goals: true } },
      sessionStartSource: 'startup',
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });
    this.setThreadId(started.result!.thread.id);
  }

  private async findLatestThreadForCwd(): Promise<string | null> {
    const response = await this.request<{ data: Array<{ id: string; cwd?: string }> }>('thread/list', {
      cwd: this._cwd,
      limit: 1,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      archived: false,
    });
    return response.result?.data?.[0]?.id || null;
  }

  /**
   * Mid-turn parity with the Claude PTY-injection path: while a turn is
   * executing, try `turn/steer` so the message lands in the active turn at the
   * next model step instead of waiting for turn/completed.
   *
   * Every input is first written to the durable queue. A successful steer RPC
   * is only an acceptance ACK, not proof that the userMessage was incorporated
   * into the turn. The queue entry is removed only after an item notification
   * (or terminal turn payload) contains its clientUserMessageId. Otherwise it
   * is replayed as the next native turn. Any steer rejection therefore needs
   * no special recovery: the already-durable entry remains queued.
   *
   * CODEX_STEER_DISABLED=1 reverts to pure queueing.
   */
  private queueTurn(input: unknown[]): void {
    const pending = this.appendTurn(input);
    if (!pending) return;

    if (
      this._executing
      && this._activeTurnId
      && !this._turnCompletion?.recovering
      && process.env.CODEX_STEER_DISABLED !== '1'
    ) {
      this.steerActiveTurn(pending).catch((err) => {
        this._outputBuffer.push(`[codex-app-server] steer path failed: ${err}\n`);
      });
      return;
    }
    if (!this._executing) {
      this.drainQueue().catch((err) => {
        this._outputBuffer.push(`[codex-app-server] turn queue failed: ${err}\n`);
      });
    }
  }

  private appendTurn(input: unknown[]): DurableTurn | null {
    const pending: DurableTurn = {
      id: `ctx-${randomBytes(16).toString('hex')}`,
      input,
      enqueuedAt: new Date().toISOString(),
    };
    const next = [...this._turnQueue, pending];
    try {
      this.persistTurnQueue(next);
    } catch (err) {
      // Keep the in-memory copy and continue delivering, but make the loss of
      // crash durability explicit instead of silently pretending it persisted.
      this._outputBuffer.push(`[codex-app-server] durable queue write failed: ${err}\n`);
    }
    this._turnQueue = next;
    return pending;
  }

  private async steerActiveTurn(pending: DurableTurn): Promise<void> {
    const expectedTurnId = this._activeTurnId;
    if (!this._threadId || !expectedTurnId || this._turnCompletion?.recovering) return;

    try {
      const response = await this.request<{ turnId: string }>('turn/steer', {
        threadId: this._threadId,
        expectedTurnId,
        clientUserMessageId: pending.id,
        input: pending.input,
      });
      const acceptedTurnId = response.result?.turnId;
      if (acceptedTurnId && acceptedTurnId !== expectedTurnId) {
        this._outputBuffer.push(
          `[codex-app-server] steer ACK mismatch expected=${expectedTurnId} actual=${acceptedTurnId}; retaining fallback\n`,
        );
        return;
      }
      this._outputBuffer.push(
        `[codex-app-server] steer accepted turn=${expectedTurnId} message=${pending.id}; awaiting materialization\n`,
      );
    } catch (err) {
      // Do not retry steer here: the rejection may be a non-steerable turn
      // (review/compact). The durable entry will run immediately after the
      // active turn reaches a terminal notification.
      this._outputBuffer.push(`[codex-app-server] steer rejected, retaining fallback: ${err}\n`);
    }
  }

  private async drainQueue(): Promise<void> {
    while (this._alive && this._turnQueue.length > 0) {
      const pending = this._turnQueue[0];
      this._executing = true;
      try {
        await this.startTurn(pending);
      } finally {
        this._executing = false;
      }
    }
  }

  private async startTurn(pending: DurableTurn): Promise<void> {
    if (!this._threadId) throw new Error('No Codex app-server thread is active');
    const completion = this.createTurnCompletion(this.getTurnTimeoutMs());
    let response: JsonRpcResponse<TurnResponse>;
    try {
      response = await this.request<TurnResponse>('turn/start', {
        threadId: this._threadId,
        clientUserMessageId: pending.id,
        input: pending.input,
        ...TURN_PERMISSION_OVERRIDES,
      });
    } catch (err) {
      const requestError = err instanceof Error ? err : new Error(String(err));
      this.rejectTurnCompletion(requestError);
      await completion.catch(() => {});
      throw requestError;
    }

    if (this._turnCompletion && response.result?.turn?.id && !this._activeTurnId) {
      this._activeTurnId = response.result.turn.id;
    }
    // turn/start success means the native thread owns this input. If the
    // response was lost after server acceptance, restart reconciliation uses
    // clientUserMessageId to reach the same conclusion from thread history.
    this.markTurnMaterialized(pending.id);
    await completion;
  }

  private readTurnQueue(): DurableTurn[] {
    if (!existsSync(this._turnQueuePath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this._turnQueuePath, 'utf-8')) as Partial<DurableTurnQueue>;
      if (parsed.version !== 1 || !Array.isArray(parsed.items)) {
        throw new Error('unsupported queue schema');
      }
      return parsed.items.filter((item): item is DurableTurn => (
        isRecord(item)
        && typeof item.id === 'string'
        && Array.isArray(item.input)
        && typeof item.enqueuedAt === 'string'
      ));
    } catch (err) {
      this._outputBuffer.push(`[codex-app-server] durable queue read failed: ${err}\n`);
      return [];
    }
  }

  private persistTurnQueue(items = this._turnQueue): void {
    const payload: DurableTurnQueue = { version: 1, items };
    atomicWriteSync(this._turnQueuePath, JSON.stringify(payload, null, 2), true);
  }

  private markTurnMaterialized(clientId: string): void {
    const next = this._turnQueue.filter((pending) => pending.id !== clientId);
    if (next.length === this._turnQueue.length) return;

    try {
      // Persist the acknowledgement before changing memory. On a write
      // failure, retaining/replaying the message is safer than losing it.
      this.persistTurnQueue(next);
      this._turnQueue = next;
      this._outputBuffer.push(`[codex-app-server] materialized message=${clientId}\n`);
    } catch (err) {
      this._outputBuffer.push(
        `[codex-app-server] queue acknowledgement failed; retaining fallback message=${clientId}: ${err}\n`,
      );
    }
  }

  private markMaterializedInputsFromItems(items: unknown): void {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!isRecord(item) || item.type !== 'userMessage' || typeof item.clientId !== 'string') continue;
      this.markTurnMaterialized(item.clientId);
    }
  }

  /**
   * A crash can happen after app-server persisted a turn but before the
   * adapter removed its durable fallback. On resume, reconcile client ids
   * against native thread history before draining, giving deterministic
   * at-least-once delivery without replaying inputs already materialized.
   */
  private async reconcilePersistedTurnQueue(): Promise<void> {
    if (!this._threadId || this._turnQueue.length === 0) return;
    try {
      const response = await this.request<{
        thread: { turns?: Array<{ items?: unknown[] }> };
      }>('thread/read', {
        threadId: this._threadId,
        includeTurns: true,
      });
      for (const turn of response.result?.thread.turns || []) {
        this.markMaterializedInputsFromItems(turn.items);
      }
    } catch (err) {
      // Reconciliation failure is fail-safe: retain and replay the durable
      // inputs rather than dropping them on an unverifiable assumption.
      this._outputBuffer.push(`[codex-app-server] queue reconciliation failed; retaining fallbacks: ${err}\n`);
    }
  }

  /**
   * Local-command reply: writes to the agent log AND mirrors back to Telegram.
   * Local commands (`/goal`, `$skill` errors) are handled inside the adapter
   * without an LLM turn, so the user only sees a response if we send it.
   */
  private replyLocal(text: string): void {
    this._outputBuffer.push(text + '\n');
    if (this._telegramApi && this._chatId) {
      this._telegramApi.sendMessage(this._chatId, text, undefined, { parseMode: null }).catch(() => {});
    }
  }

  private async setGoal(objective: string): Promise<void> {
    if (!this._threadId) throw new Error('No Codex app-server thread is active');
    const response = await this.request<GoalResponse>('thread/goal/set', {
      threadId: this._threadId,
      objective,
    });
    this.replyLocal(`[goal] ${response.result?.goal?.status || 'active'}: ${objective}`);
  }

  private async getGoal(): Promise<void> {
    if (!this._threadId) throw new Error('No Codex app-server thread is active');
    const response = await this.request<GoalResponse>('thread/goal/get', { threadId: this._threadId });
    const goal = response.result?.goal;
    this.replyLocal(goal?.objective
      ? `[goal] ${goal.status || 'active'}: ${goal.objective}`
      : '[goal] none set');
  }

  private async clearGoal(): Promise<void> {
    if (!this._threadId) throw new Error('No Codex app-server thread is active');
    await this.request('thread/goal/clear', { threadId: this._threadId });
    this.replyLocal('[goal] cleared');
  }

  private async handleSkillInput(content: string): Promise<void> {
    const match = content.match(/^\$([A-Za-z0-9:_-]+)(?:\s+([\s\S]*))?$/);
    if (!match) {
      this.replyLocal('[skill] expected $skill_name [text]');
      return;
    }

    const [, skillName, trailingText] = match;
    const skills = await this.request<SkillsListResponse>('skills/list', {
      cwds: [this._cwd],
      forceReload: false,
    });
    const allSkills = (skills.result?.data || []).flatMap((entry) => entry.skills || []);
    const exact = allSkills.find((skill) => skill.enabled !== false && skill.name === skillName);
    if (!exact) {
      const matches = allSkills
        .filter((skill) => skill.enabled !== false && skill.name.includes(skillName))
        .slice(0, 5)
        .map((skill) => skill.name);
      this.replyLocal(matches.length > 0
        ? `[skill] unknown "${skillName}". Did you mean: ${matches.join(', ')}?`
        : `[skill] unknown "${skillName}". No enabled matches found.`);
      return;
    }

    const input: unknown[] = [{ type: 'skill', name: exact.name, path: exact.path }];
    if (trailingText?.trim()) {
      input.push({ type: 'text', text: trailingText.trim(), text_elements: [] });
    }
    this.queueTurn(input);
  }

  private handleRpcMessage(message: unknown): void {
    if (!isRecord(message)) return;

    if ('method' in message && 'id' in message) {
      const method = String(message.method);
      const id = message.id as number | string;
      this._outputBuffer.push(`[codex-app-server] unsupported request: ${method}\n`);
      this.emitUnsupportedRequestEvent(method);
      this._rpc?.respondError(id, -32601, `Unsupported app-server request: ${method}`);
      return;
    }

    if (!('method' in message)) return;
    const method = String(message.method);
    const params = isRecord(message.params) ? message.params : {};
    const notificationThreadId = typeof params.threadId === 'string' ? params.threadId : null;

    // A single app-server connection multiplexes notifications for the parent
    // thread and any Codex subagent threads it spawns. Only the parent thread
    // belongs to this adapter. Without this guard, a child's turn/started
    // overwrites _activeTurnId and its turn/completed resolves the parent's
    // queue gate, causing stale turn/steer requests and concurrent turns.
    //
    // Some older/mock notifications omit threadId, so preserve the historical
    // behavior for those events.
    if (this._threadId && notificationThreadId && notificationThreadId !== this._threadId) {
      if (method === 'turn/started' || method === 'turn/completed' || method === 'error') {
        this._outputBuffer.push(
          `[codex-app-server] ignored foreign-thread ${method} thread=${notificationThreadId}\n`,
        );
      }
      return;
    }

    switch (method) {
      case 'thread/started':
        this._outputBuffer.push('[codex-app-server] thread started\n');
        break;
      case 'thread/status/changed':
        this._outputBuffer.push(`[codex-app-server] status ${JSON.stringify(params.status)}\n`);
        if (isRecord(params.status) && params.status.type === 'idle') {
          this.writeIdleFlag();
        } else {
          this.maybeFireTyping();
        }
        break;
      case 'turn/started':
        if (isRecord(params.turn) && typeof params.turn.id === 'string') {
          this._activeTurnId = params.turn.id;
          this.markMaterializedInputsFromItems(params.turn.items);
        }
        this.maybeFireTyping();
        this._outputBuffer.push('[codex-app-server] turn started\n');
        break;
      case 'turn/completed':
        if (
          this._activeTurnId
          && isRecord(params.turn)
          && typeof params.turn.id === 'string'
          && params.turn.id !== this._activeTurnId
        ) {
          this._outputBuffer.push(
            `[codex-app-server] ignored stale turn/completed expected=${this._activeTurnId} actual=${params.turn.id}\n`,
          );
          break;
        }
        if (isRecord(params.turn)) {
          this.markMaterializedInputsFromItems(params.turn.items);
        }
        this._activeTurnId = null;
        this.writeIdleFlag();
        this._outputBuffer.push('[codex-app-server] turn completed\n');
        this.resolveTurnCompletion();
        break;
      case 'item/agentMessage/delta':
        if (typeof params.delta === 'string') {
          this._outputBuffer.push(params.delta);
        }
        this.maybeFireTyping();
        break;
      case 'item/started':
      case 'item/completed':
        if (isRecord(params.item) && params.item.type === 'userMessage' && typeof params.item.clientId === 'string') {
          this.markTurnMaterialized(params.item.clientId);
        }
        if (isRecord(params.item) && params.item.type === 'agentMessage' && typeof params.item.text === 'string') {
          this._outputBuffer.push('\n');
        }
        break;
      case 'turn/plan/updated':
      case 'item/plan/delta':
        this._outputBuffer.push(`[plan] ${JSON.stringify(params)}\n`);
        this.maybeFireTyping();
        break;
      case 'thread/goal/updated':
        if (isRecord(params.goal)) {
          this._outputBuffer.push(`[goal] ${params.goal.status || 'active'}: ${params.goal.objective || ''}\n`);
        }
        break;
      case 'thread/goal/cleared':
        this._outputBuffer.push('[goal] cleared\n');
        break;
      case 'error':
        this._outputBuffer.push(`[codex-app-server] error: ${JSON.stringify(params)}\n`);
        // Retryable transport/model errors do not end the turn. The app-server
        // will continue the same turn and later emit turn/completed.
        if (params.willRetry === true) break;
        this._activeTurnId = null;
        this.rejectTurnCompletion(new Error(JSON.stringify(params)));
        break;
      case 'thread/tokenUsage/updated':
        this.writeContextStatus(params);
        this.appendCodexTokenLog(params);
        this._outputBuffer.push(`[codex-app-server:event] ${method}\n`);
        break;
      case 'warning':
      case 'mcpServer/startupStatus/updated':
      case 'account/rateLimits/updated':
      case 'skills/changed':
        this._outputBuffer.push(`[codex-app-server:event] ${method}\n`);
        break;
      default:
        this._outputBuffer.push(`[codex-app-server:event] ${method}\n`);
    }
  }

  private request<T>(method: string, params: unknown): Promise<JsonRpcResponse<T>> {
    if (!this._rpc) throw new Error('Codex app-server RPC is not connected');
    return this._rpc.request<T>(method, params);
  }

  private createTurnCompletion(timeoutMs = DEFAULT_TURN_TIMEOUT_MS): Promise<void> {
    if (this._turnCompletion) {
      this.rejectTurnCompletion(new Error('Superseded by a new turn'));
    }
    return new Promise((resolve, reject) => {
      const pending: TurnCompletion = {
        resolve,
        reject,
        timer: null,
        recoveryTimer: null,
        recovering: false,
      };
      pending.timer = setTimeout(() => {
        if (this._turnCompletion !== pending) return;
        pending.timer = null;
        pending.recovering = true;
        this._outputBuffer.push(
          `[codex-app-server] turn completion timeout; interrupting active turn=${this._activeTurnId || 'unknown'}\n`,
        );
        this.recoverTimedOutTurn(pending).catch((err) => {
          this._outputBuffer.push(`[codex-app-server] timeout recovery failed: ${err}\n`);
          this.forceTimedOutTurnRestart(pending);
        });
      }, timeoutMs);
      this._turnCompletion = pending;
    });
  }

  /**
   * Do not reject the waiter merely because its wall-clock timer expired. The
   * native turn is still active until app-server emits a terminal lifecycle
   * event. Rejecting early creates a split brain: drainQueue starts a second
   * turn while the first one remains inProgress. Instead, interrupt the exact
   * native turn and keep the queue gate closed until turn/completed arrives.
   */
  private async recoverTimedOutTurn(pending: TurnCompletion): Promise<void> {
    const threadId = this._threadId;
    const turnId = this._activeTurnId;
    // Arm the hard stop before awaiting RPC. A wedged transport must not be
    // able to postpone recovery forever by never settling turn/interrupt.
    pending.recoveryTimer = setTimeout(
      () => this.forceTimedOutTurnRestart(pending),
      this.getTurnInterruptGraceMs(),
    );

    if (threadId && turnId) {
      try {
        await this.request('turn/interrupt', { threadId, turnId });
        this._outputBuffer.push(`[codex-app-server] interrupt accepted turn=${turnId}; awaiting terminal event\n`);
      } catch (err) {
        // A completion can race the interrupt request. Keep the gate closed for
        // the grace period; the terminal event will resolve it if it arrives.
        this._outputBuffer.push(`[codex-app-server] interrupt rejected turn=${turnId}: ${err}\n`);
      }
    } else {
      this._outputBuffer.push('[codex-app-server] timed-out turn id unavailable; awaiting recovery grace\n');
    }
  }

  private forceTimedOutTurnRestart(pending: TurnCompletion): void {
    if (this._turnCompletion !== pending) return;
    this._outputBuffer.push(
      '[codex-app-server] timed-out turn did not terminate; forcing app-server restart with durable queue retained\n',
    );
    this.kill();
  }

  private getTurnTimeoutMs(): number {
    return positiveIntegerEnv('CODEX_TURN_TIMEOUT_MS', DEFAULT_TURN_TIMEOUT_MS);
  }

  private getTurnInterruptGraceMs(): number {
    return positiveIntegerEnv('CODEX_TURN_INTERRUPT_GRACE_MS', DEFAULT_TURN_INTERRUPT_GRACE_MS);
  }

  private resolveTurnCompletion(): void {
    if (!this._turnCompletion) return;
    const pending = this._turnCompletion;
    this._turnCompletion = null;
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.recoveryTimer) clearTimeout(pending.recoveryTimer);
    pending.resolve();
  }

  private rejectTurnCompletion(err: Error): void {
    if (!this._turnCompletion) return;
    const pending = this._turnCompletion;
    this._turnCompletion = null;
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.recoveryTimer) clearTimeout(pending.recoveryTimer);
    pending.reject(err);
  }

  private emitUnsupportedRequestEvent(method: string): void {
    try {
      const paths = resolvePaths(this._env.agentName, this._env.instanceId, this._env.org);
      logEvent(
        paths,
        this._env.agentName,
        this._env.org,
        'error',
        'codex_app_server_unsupported_request',
        'error',
        {
          runtime: 'codex-app-server',
          method,
          thread_id: this._threadId,
        },
      );
    } catch {
      // OutputBuffer warning above is the user-visible fallback.
    }
  }

  private setThreadId(threadId: string): void {
    this._threadId = threadId;
    const state: ThreadState = {
      threadId,
      cwd: this._cwd,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(this._threadStatePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  }

  /**
   * Translate a `thread/tokenUsage/updated` notification from codex-app-server
   * into the context_status.json shape consumed by the FastChecker context
   * monitor. Writes atomically; failures are non-fatal (observability only).
   *
   * Mapping (per codex schema ThreadTokenUsageUpdatedNotification):
   *   - used_percentage = last.totalTokens / cap * 100  (clamped to [0, 100])
   *   - context_window_size = modelContextWindow ?? config.codex_context_cap ?? 256000
   *   - exceeds_200k_tokens = last.totalTokens > 200000
   *   - current_usage.{input,output,cache_read} from last.{input,output,cachedInput}Tokens
   *   - session_id = current threadId
   *
   * `total` is lifetime cumulative across the app-server thread and can grow far
   * beyond the active model window. Context handoff must use the current window
   * occupancy (`last`) so long-lived threads do not report false 100%.
   */
  private writeContextStatus(params: Record<string, unknown>): void {
    const tokenUsage = isRecord(params.tokenUsage) ? params.tokenUsage : null;
    if (!tokenUsage) return;
    const current = isRecord(tokenUsage.last) ? tokenUsage.last : null;
    const currentTokens = current && typeof current.totalTokens === 'number' ? current.totalTokens : null;

    const modelContextWindow = typeof tokenUsage.modelContextWindow === 'number'
      ? tokenUsage.modelContextWindow
      : null;
    const cap = modelContextWindow ?? this._config.codex_context_cap ?? 256000;
    const usedPct = cap > 0 && currentTokens !== null
      ? Math.min(100, (currentTokens / cap) * 100)
      : null;

    const inputTokens = current && typeof current.inputTokens === 'number' ? current.inputTokens : 0;
    const outputTokens = current && typeof current.outputTokens === 'number' ? current.outputTokens : 0;
    const cachedInputTokens = current && typeof current.cachedInputTokens === 'number' ? current.cachedInputTokens : 0;

    const payload = JSON.stringify({
      used_percentage: usedPct,
      context_window_size: cap,
      exceeds_200k_tokens: currentTokens !== null ? currentTokens > 200000 : false,
      current_usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cachedInputTokens,
        cache_creation_input_tokens: 0,
      },
      session_id: this._threadId,
      written_at: new Date().toISOString(),
    });

    try {
      atomicWriteSync(join(this._stateDir, 'context_status.json'), payload);
    } catch {
      // Non-fatal: FastChecker will skip stale/missing files gracefully.
    }
  }

  /**
   * Append a per-turn token usage record to <ctxRoot>/logs/<agent>/codex-tokens.jsonl
   * so the dashboard cost-parser can scan it alongside ~/.claude/projects/*.jsonl.
   * One JSONL line per `thread/tokenUsage/updated` notification; dedup by
   * (session_id, turn_id) is the parser's responsibility.
   */
  private appendCodexTokenLog(params: Record<string, unknown>): void {
    const tokenUsage = isRecord(params.tokenUsage) ? params.tokenUsage : null;
    if (!tokenUsage) return;
    const total = isRecord(tokenUsage.total) ? tokenUsage.total : null;
    if (!total) return;

    const turnId = typeof params.turnId === 'string' ? params.turnId : null;
    if (!turnId || !this._threadId) return;

    const entry = {
      timestamp: new Date().toISOString(),
      model: this._config.model || 'gpt-5-codex',
      input_tokens: typeof total.inputTokens === 'number' ? total.inputTokens : 0,
      output_tokens: typeof total.outputTokens === 'number' ? total.outputTokens : 0,
      cache_read_tokens: typeof total.cachedInputTokens === 'number' ? total.cachedInputTokens : 0,
      cache_write_tokens: 0,
      session_id: this._threadId,
      turn_id: turnId,
    };

    try {
      const logDir = join(this._env.ctxRoot, 'logs', this._env.agentName);
      ensureDir(logDir);
      appendFileSync(join(logDir, 'codex-tokens.jsonl'), `${JSON.stringify(entry)}\n`);
    } catch {
      // Non-fatal: cost reporting is observability only.
    }
  }

  private readThreadState(): ThreadState | null {
    if (!existsSync(this._threadStatePath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this._threadStatePath, 'utf-8')) as ThreadState;
      return parsed.cwd === this._cwd && parsed.threadId ? parsed : null;
    } catch {
      return null;
    }
  }

  private resolveSocketPath(): { path: string; listenArg: string; cwd: string } {
    const defaultPath = join(this._stateDir, SOCKET_BASENAME);
    if (Buffer.byteLength(defaultPath) < SOCKET_PATH_WARN_BYTES) {
      return { path: defaultPath, listenArg: `unix://./${SOCKET_BASENAME}`, cwd: this._stateDir };
    }

    const fallbackBasename = `cas-${randomBytes(4).toString('hex')}.sock`;
    const fallback = join('/tmp', fallbackBasename);
    const pointer: SocketPointer = {
      socketPath: fallback,
      fallback: true,
      reason: 'state socket path exceeded 100 bytes',
      updatedAt: new Date().toISOString(),
    };
    try {
      ensureDir(this._stateDir);
      writeFileSync(this._socketPointerPath, `${JSON.stringify(pointer, null, 2)}\n`, 'utf-8');
    } catch {
      // Non-fatal; spawn will still use fallback path.
    }
    return { path: fallback, listenArg: `unix://./${fallbackBasename}`, cwd: '/tmp' };
  }

  private removeSocket(): void {
    try {
      if (existsSync(this._socketPath)) unlinkSync(this._socketPath);
    } catch {
      // Ignore stale socket cleanup failures.
    }
  }

  private cleanupSpawnAttempt(): void {
    const pty = this._appServerPty;
    this._appServerPty = null;
    if (pty) {
      try {
        pty.kill();
      } catch {
        // Ignore failed attempt cleanup errors.
      }
    }
    this.removeSocket();
  }

  private writeIdleFlag(): void {
    try {
      writeFileSync(join(this._stateDir, 'last_idle.flag'), Math.floor(Date.now() / 1000).toString(), 'utf-8');
    } catch {
      // Non-fatal.
    }
  }

  private maybeFireTyping(): void {
    if (!this._telegramApi || !this._chatId) return;
    const now = Date.now();
    if (now - this._typingLastSent < 4000) return;
    this._typingLastSent = now;
    this._telegramApi.sendChatAction(this._chatId, 'typing').catch(() => { /* non-fatal */ });
  }

  private buildEnv(): Record<string, string> {
    const env: Record<string, string> = {};

    const keepVars = ['PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'TMPDIR'];
    for (const key of keepVars) {
      if (process.env[key]) env[key] = process.env[key]!;
    }

    env['CTX_INSTANCE_ID'] = this._env.instanceId;
    env['CTX_ROOT'] = this._env.ctxRoot;
    env['CTX_FRAMEWORK_ROOT'] = this._env.frameworkRoot;
    env['CTX_AGENT_NAME'] = this._env.agentName;
    env['CTX_ORG'] = this._env.org;
    env['CTX_AGENT_DIR'] = this._env.agentDir;
    env['CTX_PROJECT_ROOT'] = this._env.projectRoot;

    if (this._env.org && this._env.projectRoot) {
      this.loadEnvFile(join(this._env.projectRoot, 'orgs', this._env.org, 'secrets.env'), env);
    }
    this.loadEnvFile(join(this._env.agentDir, '.env'), env);

    if (env['CHAT_ID']) env['CTX_TELEGRAM_CHAT_ID'] = env['CHAT_ID'];
    if (this._config.timezone) {
      env['CTX_TIMEZONE'] = this._config.timezone;
      env['TZ'] = this._config.timezone;
    }

    return env;
  }

  private loadEnvFile(path: string, env: Record<string, string>): void {
    if (!existsSync(path)) return;
    try {
      for (const line of readFileSync(path, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
        }
      }
    } catch {
      // Ignore env file read errors.
    }
  }

  private getPackageVersion(): string {
    try {
      const pkg = require('../../package.json') as { version?: string };
      return pkg.version || '0.0.0';
    } catch {
      return '0.0.0';
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
