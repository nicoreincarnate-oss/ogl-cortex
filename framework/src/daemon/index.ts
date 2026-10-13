import { AgentManager } from './agent-manager.js';
import { IPCServer } from './ipc-server.js';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { ensureDir } from '../utils/atomic.js';
import type { HarnessService } from '../harness/service.js';
import {
  acquireDaemonSingleton,
  releaseDaemonSingleton,
  type DaemonSingletonOwnership,
} from './singleton-lock.js';

// Each fast-checker registers a process-level SIGUSR1 handler (see
// fast-checker.ts:102). With >10 active agents the default Node listener cap
// trips MaxListenersExceededWarning. Bump for the full fleet.
process.setMaxListeners(20);

// ---------------------------------------------------------------------------
// Crash handling: turn silent daemon deaths into attributable, observable
// events. Three responsibilities:
//   1. Write a .daemon-crashed marker per agent — hook-crash-alert.ts uses
//      this on the next session boot to emit "🚨 daemon crashed" instead of
//      the misleading "🚨 agent crashed" default.
//   2. Maintain a small crash-history JSON so we can detect crash-loops.
//   3. On ≥3 crashes in 15 min, send ONE Telegram alert to the operator chat
//      (with a 30-min cooldown). PM2's max_restarts: 10 is the final
//      circuit breaker; our alert fires before the fleet goes fully dead.
// Context: root cause of 2026-04-22 restart storm was unguarded this.pty!
// in worker-process.ts:93 — PR #196 fixed 3 sister sites but missed this
// one. The inject.ts try/catch + worker-process ?. land the structural fix;
// this module is the visibility layer.
// ---------------------------------------------------------------------------

export interface CrashEvent { ts: string; err: string; }
export interface CrashHistory { crashes: CrashEvent[]; lastAlertAt?: string; }

export const CRASH_HISTORY_MAX = 20;
export const CRASH_LOOP_WINDOW_MS = 15 * 60 * 1000;    // 15 min detection window
export const CRASH_LOOP_THRESHOLD = 3;                  // 3 crashes trips the alert
export const CRASH_LOOP_COOLDOWN_MS = 30 * 60 * 1000;   // 30 min between alerts
const TELEGRAM_SEND_TIMEOUT_MS = 3000;           // bounded — we're crashing

function supportsShadowHarnessRuntime(): boolean {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);
  return Number.isFinite(major) && major >= 26;
}

function shadowHarnessActivationRequested(): boolean {
  const value = process.env.CORTEX_HARNESS_ENABLE?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

export function crashHistoryPath(ctxRoot: string): string {
  return join(ctxRoot, 'state', '.daemon-crash-history.json');
}

export function readCrashHistory(ctxRoot: string): CrashHistory {
  const p = crashHistoryPath(ctxRoot);
  if (!existsSync(p)) return { crashes: [] };
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as CrashHistory;
    return { crashes: parsed.crashes ?? [], lastAlertAt: parsed.lastAlertAt };
  } catch {
    return { crashes: [] };
  }
}

export function writeCrashHistory(ctxRoot: string, history: CrashHistory): void {
  try {
    ensureDir(join(ctxRoot, 'state'));
    writeFileSync(crashHistoryPath(ctxRoot), JSON.stringify(history, null, 2), 'utf-8');
  } catch {
    // disk full / permission issue — don't block exit
    console.error('[daemon] Failed to persist crash history (non-fatal)');
  }
}

export function recordCrash(ctxRoot: string, errStr: string): CrashHistory {
  const history = readCrashHistory(ctxRoot);
  history.crashes.push({ ts: new Date().toISOString(), err: errStr.slice(0, 2000) });
  if (history.crashes.length > CRASH_HISTORY_MAX) {
    history.crashes = history.crashes.slice(-CRASH_HISTORY_MAX);
  }
  writeCrashHistory(ctxRoot, history);
  return history;
}

export function shouldSendCrashLoopAlert(history: CrashHistory): boolean {
  const now = Date.now();
  const windowStart = now - CRASH_LOOP_WINDOW_MS;
  const recent = history.crashes.filter(c => Date.parse(c.ts) >= windowStart).length;
  if (recent < CRASH_LOOP_THRESHOLD) return false;
  if (history.lastAlertAt) {
    const cooldownEnd = Date.parse(history.lastAlertAt) + CRASH_LOOP_COOLDOWN_MS;
    if (now < cooldownEnd) return false;
  }
  return true;
}

export function countRecentCrashes(history: CrashHistory): number {
  const windowStart = Date.now() - CRASH_LOOP_WINDOW_MS;
  return history.crashes.filter(c => Date.parse(c.ts) >= windowStart).length;
}

export function writeDaemonCrashedMarkers(ctxRoot: string): void {
  // Scan state/ for per-agent dirs (each agent has state/<name>/ created
  // by AgentProcess). Writing here parallels the .daemon-stop marker path
  // in agent-manager.ts:stopAll — lets hook-crash-alert.ts distinguish
  // crash from planned stop. Each write is independently try/catch'd so
  // a single bad agent dir can't block the exit path.
  const stateDir = join(ctxRoot, 'state');
  if (!existsSync(stateDir)) return;
  let names: string[];
  try {
    names = readdirSync(stateDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch { return; }
  const ts = new Date().toISOString();
  for (const name of names) {
    try {
      writeFileSync(join(stateDir, name, '.daemon-crashed'), ts, 'utf-8');
    } catch { /* swallow per-agent */ }
  }
}

function getOperatorChatCreds(frameworkRoot: string): { chatId: string; botToken: string } | null {
  // Priority 1: explicit operator env (recommended for production).
  const envChat = process.env.CTX_OPERATOR_CHAT_ID;
  const envToken = process.env.CTX_OPERATOR_BOT_TOKEN;
  if (envChat && envToken && /^\d+:[A-Za-z0-9_-]+$/.test(envToken)) {
    return { chatId: envChat, botToken: envToken };
  }
  // Priority 2: fall back to the first agent's .env. Good enough for
  // small single-operator installs — alert still lands SOMEWHERE visible.
  try {
    const orgsRoot = join(frameworkRoot, 'orgs');
    if (!existsSync(orgsRoot)) return null;
    const orgs = readdirSync(orgsRoot, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const org of orgs) {
      const agentsRoot = join(orgsRoot, org.name, 'agents');
      if (!existsSync(agentsRoot)) continue;
      const agents = readdirSync(agentsRoot, { withFileTypes: true }).filter(d => d.isDirectory());
      for (const a of agents) {
        const envFile = join(agentsRoot, a.name, '.env');
        if (!existsSync(envFile)) continue;
        try {
          const content = readFileSync(envFile, 'utf-8');
          const tokenMatch = content.match(/^BOT_TOKEN=(.+)$/m);
          const chatMatch = content.match(/^CHAT_ID=(.+)$/m);
          if (!tokenMatch || !chatMatch) continue;
          const botToken = tokenMatch[1].trim();
          const chatId = envChat || chatMatch[1].trim();
          if (/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) {
            return { chatId, botToken };
          }
        } catch { /* skip this agent */ }
      }
    }
  } catch { /* fall through */ }
  return null;
}

function sendCrashLoopAlertBestEffort(
  frameworkRoot: string,
  crashCount: number,
  errStr: string,
): boolean {
  const creds = getOperatorChatCreds(frameworkRoot);
  if (!creds) {
    console.error('[daemon] Crash-loop alert: no operator chat configured ' +
      '(set CTX_OPERATOR_CHAT_ID + CTX_OPERATOR_BOT_TOKEN, or ensure at least one agent .env exists)');
    return false;
  }
  const message =
    `🚨 CRITICAL: cortextos daemon is crash-looping\n` +
    `${crashCount} crashes in 15 minutes\n` +
    `Last error: ${errStr.slice(0, 500)}\n` +
    `Next alert in 30 min if the pattern continues.`;
  try {
    const r = spawnSync('curl', [
      '-s', '--max-time', '3',
      '-X', 'POST',
      `https://api.telegram.org/bot${creds.botToken}/sendMessage`,
      '-d', `chat_id=${creds.chatId}`,
      '--data-urlencode', `text=${message}`,
    ], { timeout: TELEGRAM_SEND_TIMEOUT_MS, stdio: 'pipe' });
    if (r.status === 0) {
      console.error('[daemon] Crash-loop alert sent to operator chat');
      return true;
    }
    console.error('[daemon] Crash-loop alert send failed (non-fatal)');
    return false;
  } catch {
    return false;
  }
}

/**
 * Shared fatal-error handler for both uncaughtException and
 * unhandledRejection. Performs marker writes + crash recording + optional
 * telegram alert, then optionally exits. Stays fully synchronous so it
 * finishes before Node's default crash behavior triggers.
 */
function handleFatal(
  tag: 'uncaughtException' | 'unhandledRejection',
  err: unknown,
  ctxRoot: string,
  frameworkRoot: string,
  doExit: boolean,
  beforeExit?: () => void,
): void {
  const errStr = err instanceof Error ? (err.stack || err.message) : String(err);
  console.error(`[daemon] FATAL ${tag}${doExit ? ' — exiting for PM2 respawn' : ''}`);
  console.error(errStr);

  if (doExit && beforeExit) {
    try { beforeExit(); } catch (cleanupError) {
      console.error('[daemon] Fatal pre-exit cleanup failed:', cleanupError);
    }
  }

  writeDaemonCrashedMarkers(ctxRoot);
  const history = recordCrash(ctxRoot, errStr);

  if (shouldSendCrashLoopAlert(history)) {
    const recent = countRecentCrashes(history);
    if (sendCrashLoopAlertBestEffort(frameworkRoot, recent, errStr)) {
      history.lastAlertAt = new Date().toISOString();
      writeCrashHistory(ctxRoot, history);
    }
  }

  if (doExit) process.exit(1);
}

/**
 * cortextOS Daemon - single process managing all agents.
 * Run via `pm2 start ecosystem.config.js` or `cortextos ecosystem && pm2 start`.
 */
class Daemon {
  private agentManager: AgentManager | null = null;
  private ipcServer: IPCServer | null = null;
  private harnessService: HarnessService | null = null;
  private singletonOwnership: DaemonSingletonOwnership | null = null;
  private shuttingDown = false;
  private instanceId: string;
  private ctxRoot: string;

  constructor() {
    this.instanceId = process.env.CTX_INSTANCE_ID || 'default';
    // Always derive ctxRoot from instanceId to avoid inheriting a parent cortextOS's CTX_ROOT
    this.ctxRoot = join(homedir(), '.cortextos', this.instanceId);
  }

  /**
   * Stop new orchestration work before touching agent processes. Closing the
   * harness first cancels its scheduler; stopping IPC next prevents new work
   * from entering while AgentManager drains existing children.
   */
  private stopHarnessAndIpcSync(): void {
    if (this.harnessService) {
      try {
        this.harnessService.close();
      } catch (err) {
        console.error('[daemon] Error closing shadow harness:', err);
      }
      this.harnessService = null;
    }
    if (this.ipcServer) {
      try {
        this.ipcServer.stop();
      } catch (err) {
        console.error('[daemon] Error stopping IPC server:', err);
      }
      this.ipcServer = null;
    }
  }

  private releaseSingletonOwnership(): void {
    const ownership = this.singletonOwnership;
    if (!ownership) return;
    try {
      const result = releaseDaemonSingleton(ownership);
      if (result.lockRemoved) {
        this.singletonOwnership = null;
      } else {
        console.error('[daemon] Singleton lock ownership could not be proven; lock left for safe recovery');
      }
      if (!result.pidRemoved && result.lockRemoved) {
        console.error('[daemon] PID file ownership could not be proven; PID file left untouched');
      }
    } catch (error) {
      console.error('[daemon] Failed to release singleton ownership safely:', error);
    }
  }

  private async stopAgents(): Promise<void> {
    const manager = this.agentManager;
    if (!manager) return;
    try {
      await manager.stopAll();
    } catch (err) {
      console.error('[daemon] Error while stopping agents:', err);
    } finally {
      this.agentManager = null;
    }
  }

  private async shutdown(exitCode: number): Promise<void> {
    console.log('[daemon] Shutting down...');
    this.stopHarnessAndIpcSync();
    await this.stopAgents();
    this.releaseSingletonOwnership();
    process.exit(exitCode);
  }

  private registerLifecycleHandlers(frameworkRoot: string): void {
    const handleSignal = () => {
      if (this.shuttingDown) {
        console.log('[daemon] Shutdown already in progress, ignoring signal');
        return;
      }
      this.shuttingDown = true;
      this.shutdown(0).catch((err) => {
        console.error('[daemon] Fatal shutdown error:', err);
        process.exit(1);
      });
    };

    process.on('SIGINT', handleSignal);
    process.on('SIGTERM', handleSignal);

    // uncaughtException is fatal. Quiesce the harness and IPC synchronously
    // before crash bookkeeping and process exit. unhandledRejection remains
    // observable but non-fatal, so it must not disable a healthy daemon.
    process.on('uncaughtException', (err) => {
      handleFatal(
        'uncaughtException',
        err,
        this.ctxRoot,
        frameworkRoot,
        true,
        () => this.stopHarnessAndIpcSync(),
      );
    });
    process.on('unhandledRejection', (reason) => {
      handleFatal('unhandledRejection', reason, this.ctxRoot, frameworkRoot, false);
    });
    console.log('[daemon] Fatal-error handlers registered (uncaughtException + unhandledRejection)');

    // Debug-only: SIGUSR2 induces a controlled uncaughtException for
    // live crash-path verification.
    if (process.env.CTX_DEBUG_ALLOW_CRASH_TRIGGER === '1') {
      process.on('SIGUSR2', () => {
        console.error('[daemon] SIGUSR2 received — inducing test crash (CTX_DEBUG_ALLOW_CRASH_TRIGGER=1)');
        throw new Error('Simulated daemon crash via SIGUSR2 (test harness)');
      });
      console.log('[daemon] SIGUSR2 crash trigger ENABLED (debug mode)');
    }

    // Synchronous belt-and-suspenders cleanup for explicit exits. Ownership
    // checks make this safe even if a path was replaced after startup.
    process.on('exit', () => {
      this.stopHarnessAndIpcSync();
      this.releaseSingletonOwnership();
    });
  }

  async start(): Promise<void> {
    // Force restrictive default permissions for everything the daemon writes:
    // 0700 dirs, 0600 files. Belt-and-suspenders for explicit chmod calls.
    if (process.platform !== 'win32') {
      process.umask(0o077);
    }

    console.log(`[daemon] Starting cortextOS daemon (instance: ${this.instanceId})`);

    const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT || '';
    const org = process.env.CTX_ORG || '';

    if (!frameworkRoot) {
      console.error('[daemon] CTX_FRAMEWORK_ROOT not set');
      process.exit(1);
    }

    // This is the first daemon-owned state mutation. The singleton lock is
    // acquired before PID creation and before any harness/socket/agent work.
    this.singletonOwnership = acquireDaemonSingleton(this.ctxRoot);

    try {
      // Register cleanup before the first await so startup signals and fatal
      // errors cannot strand a live-owned lock.
      this.registerLifecycleHandlers(frameworkRoot);

      this.agentManager = new AgentManager(this.instanceId, this.ctxRoot, frameworkRoot, org);

      // Node 26+ gets the local compatibility-shadow harness. Older runtimes
      // retain the complete legacy daemon path and never import node:sqlite.
      if (supportsShadowHarnessRuntime() && shadowHarnessActivationRequested()) {
        try {
          const { HarnessService: ShadowHarnessService } = await import('../harness/service.js');
          this.harnessService = new ShadowHarnessService({
            instanceId: this.instanceId,
            ctxRoot: this.ctxRoot,
            frameworkRoot,
            org: org || 'atrium',
            agentRuntimeStatus: (physicalAgent) => {
              const status = this.agentManager?.getAgentStatus(physicalAgent) ?? null;
              if (!status) return null;
              let pidLiveVerified = false;
              if (status.pid && status.pid > 0) {
                try {
                  process.kill(status.pid, 0);
                  pidLiveVerified = true;
                } catch {
                  pidLiveVerified = false;
                }
              }
              return {
                ...status,
                bootstrapped: this.agentManager?.isAgentBootstrapped(physicalAgent) ?? false,
                pidLiveVerified,
                // AgentStatus.model is configuration echo, not a provider
                // handshake. Keep these false until a broker supplies signed
                // runtime/session/completion evidence.
                actualModelVerified: false,
                sessionId: status.sessionStart,
                freshSessionCapable: false,
                completionAttestationCapable: false,
              };
            },
          });
          this.harnessService.start();
          console.log('[daemon] Compatibility-shadow harness started (production controls remain disabled)');
        } catch (error) {
          try { this.harnessService?.close(); } catch { /* constructor/startup failure cleanup */ }
          this.harnessService = null;
          console.error('[daemon] Shadow harness unavailable; legacy daemon continues:', error);
        }
      } else if (!supportsShadowHarnessRuntime()) {
        console.log('[daemon] Shadow harness skipped (requires Node 26+); legacy daemon continues');
      } else {
        console.log('[daemon] Shadow harness staged but inactive (set CORTEX_HARNESS_ENABLE=1 only after release clearance)');
      }

      this.ipcServer = new IPCServer(this.agentManager, this.instanceId, this.harnessService);
      await this.ipcServer.start();
      await this.agentManager.discoverAndStart();

      console.log(`[daemon] Running (pid: ${process.pid})`);
    } catch (error) {
      // Startup failure cleanup follows the same quiesce-before-agents order.
      this.stopHarnessAndIpcSync();
      await this.stopAgents();
      this.releaseSingletonOwnership();
      throw error;
    }
  }
}

// Only auto-start when run directly (e.g. `node dist/daemon.js` or via PM2).
// Guarding with require.main prevents accidental daemon spawn when the module
// is require()'d for testing or class imports — which would start a full daemon
// with TelegramPollers, IPC server, and Claude PTY processes as a side effect.
// See: https://github.com/grandamenium/cortextos/issues/44
if (require.main === module) {
  const daemon = new Daemon();
  daemon.start().catch(err => {
    console.error('[daemon] Fatal error:', err);
    process.exit(1);
  });
}
