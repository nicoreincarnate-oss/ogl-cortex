import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { addAgentCommand } from '../../../src/cli/add-agent.js';
import { provisionDisabledAgents } from '../../../src/cli/disabled-agent-provisioning.js';

describe('disabled-only agent provisioning', () => {
  let projectRoot: string;
  let homeRoot: string;
  let originalHome: string | undefined;
  let originalFrameworkRoot: string | undefined;
  let originalProjectRoot: string | undefined;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'cortex-disabled-project-'));
    homeRoot = mkdtempSync(join(tmpdir(), 'cortex-disabled-home-'));
    originalHome = process.env.HOME;
    originalFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
    originalProjectRoot = process.env.CTX_PROJECT_ROOT;
    process.env.HOME = homeRoot;
    process.env.CTX_FRAMEWORK_ROOT = projectRoot;
    process.env.CTX_PROJECT_ROOT = projectRoot;

    mkdirSync(join(projectRoot, 'orgs', 'atrium', 'agents'), { recursive: true });
    writeFileSync(join(projectRoot, 'orgs', 'atrium', 'context.json'), JSON.stringify({
      name: 'atrium', timezone: 'UTC',
    }));
    symlinkSync(join(__dirname, '..', '..', '..', 'templates'), join(projectRoot, 'templates'), 'dir');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    process.env.CTX_FRAMEWORK_ROOT = originalFrameworkRoot;
    process.env.CTX_PROJECT_ROOT = originalProjectRoot;
    vi.restoreAllMocks();
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(homeRoot, { recursive: true, force: true });
  });

  it('add-agent --disabled commits config and registry disabled without installing global Codex links', async () => {
    await addAgentCommand.parseAsync([
      'node', 'cli', 'safe-codex', '--disabled', '--runtime', 'codex-app-server',
      '--org', 'atrium', '--instance', 'cortextos1',
    ]);

    const agentDir = join(projectRoot, 'orgs', 'atrium', 'agents', 'safe-codex');
    const config = JSON.parse(readFileSync(join(agentDir, 'config.json'), 'utf-8'));
    const registry = JSON.parse(readFileSync(
      join(homeRoot, '.cortextos', 'cortextos1', 'config', 'enabled-agents.json'),
      'utf-8',
    ));
    expect(config).toMatchObject({
      agent_name: 'safe-codex', enabled: false, runtime: 'codex-app-server', telegram_polling: false,
    });
    expect(registry['safe-codex']).toMatchObject({
      enabled: false, org: 'atrium', runtime: 'codex-app-server', telegram_polling: false,
    });
    const env = readFileSync(join(agentDir, '.env'), 'utf-8');
    expect(env).not.toMatch(/^(?:BOT_TOKEN|CHAT_ID|ALLOWED_USER)=/m);
    expect(existsSync(join(homeRoot, '.codex', 'skills'))).toBe(false);
    expect(existsSync(join(homeRoot, '.cortextos', 'cortextos1', 'config', '.agent-provision.lock'))).toBe(false);
  });

  it('retains legacy add-agent default enabled behavior when --disabled is absent', async () => {
    await addAgentCommand.parseAsync([
      'node', 'cli', 'legacy-default', '--org', 'atrium', '--instance', 'cortextos1',
    ]);
    const config = JSON.parse(readFileSync(
      join(projectRoot, 'orgs', 'atrium', 'agents', 'legacy-default', 'config.json'),
      'utf-8',
    ));
    const registry = JSON.parse(readFileSync(
      join(homeRoot, '.cortextos', 'cortextos1', 'config', 'enabled-agents.json'),
      'utf-8',
    ));
    expect(config.enabled).toBe(true);
    expect(registry['legacy-default'].enabled).toBe(true);
  });

  it('rolls a multi-agent transaction back after a partial rename failure', () => {
    const ctxRoot = join(homeRoot, '.cortextos', 'cortextos1');
    const registryPath = join(ctxRoot, 'config', 'enabled-agents.json');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    const originalRegistry = JSON.stringify({ rick: { enabled: true, org: 'atrium' } }, null, 2) + '\n';
    writeFileSync(registryPath, originalRegistry);

    expect(() => provisionDisabledAgents({
      projectRoot,
      ctxRoot,
      specs: [
        { identity: 'f1', org: 'atrium', runtime: 'claude-code' },
        { identity: 'c1', org: 'atrium', runtime: 'codex-app-server' },
      ],
      hooks: {
        beforeRename: (_spec, index) => {
          if (index === 1) throw new Error('injected rename failure');
        },
      },
    })).toThrow(/injected rename failure/);

    expect(existsSync(join(projectRoot, 'orgs', 'atrium', 'agents', 'f1'))).toBe(false);
    expect(existsSync(join(projectRoot, 'orgs', 'atrium', 'agents', 'c1'))).toBe(false);
    expect(readFileSync(registryPath, 'utf-8')).toBe(originalRegistry);
    expect(readdirSync(join(projectRoot, 'orgs', 'atrium')).some(name => name.startsWith('.cortextos-roster-stage-'))).toBe(false);
  });

  it('refuses a corrupt registry before exposing an agent directory', () => {
    const ctxRoot = join(homeRoot, '.cortextos', 'cortextos1');
    const registryPath = join(ctxRoot, 'config', 'enabled-agents.json');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    writeFileSync(registryPath, '{not-json');

    expect(() => provisionDisabledAgents({
      projectRoot,
      ctxRoot,
      specs: [{ identity: 'f1', org: 'atrium', runtime: 'claude-code' }],
    })).toThrow(/registry is not valid JSON/);
    expect(existsSync(join(projectRoot, 'orgs', 'atrium', 'agents', 'f1'))).toBe(false);
  });

  it('retains the disabled registry if a concurrent legacy directory appears', () => {
    const ctxRoot = join(homeRoot, '.cortextos', 'cortextos1');
    const finalDir = join(projectRoot, 'orgs', 'atrium', 'agents', 'f1');
    expect(() => provisionDisabledAgents({
      projectRoot,
      ctxRoot,
      specs: [{ identity: 'f1', org: 'atrium', runtime: 'claude-code' }],
      hooks: {
        beforeRename: () => {
          mkdirSync(finalDir, { recursive: false });
          throw new Error('concurrent legacy creator');
        },
      },
    })).toThrow(/registry remains disabled for safety/);

    const registry = JSON.parse(readFileSync(
      join(ctxRoot, 'config', 'enabled-agents.json'),
      'utf-8',
    ));
    expect(registry.f1.enabled).toBe(false);
    expect(existsSync(finalDir)).toBe(true);
  });

  it('reclaims a well-formed stale lock owned by a dead process', () => {
    const ctxRoot = join(homeRoot, '.cortextos', 'cortextos1');
    const lockPath = join(ctxRoot, 'config', '.agent-provision.lock');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({
      pid: 99_999_999,
      token: 'stale-token',
      createdAt: '2000-01-01T00:00:00.000Z',
    }) + '\n');

    expect(() => provisionDisabledAgents({
      projectRoot,
      ctxRoot,
      specs: [{ identity: 'f1', org: 'atrium', runtime: 'claude-code' }],
    })).not.toThrow();
    expect(existsSync(join(projectRoot, 'orgs', 'atrium', 'agents', 'f1'))).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(`${lockPath}.reclaim`)).toBe(false);
  });

  it('refuses to steal a lock owned by a live process', () => {
    const ctxRoot = join(homeRoot, '.cortextos', 'cortextos1');
    const lockPath = join(ctxRoot, 'config', '.agent-provision.lock');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      token: 'live-token',
      createdAt: new Date().toISOString(),
    }) + '\n');

    expect(() => provisionDisabledAgents({
      projectRoot,
      ctxRoot,
      specs: [{ identity: 'f1', org: 'atrium', runtime: 'claude-code' }],
    })).toThrow(/transaction is active/);
    expect(readFileSync(lockPath, 'utf-8')).toContain('live-token');
    expect(existsSync(join(projectRoot, 'orgs', 'atrium', 'agents', 'f1'))).toBe(false);
  });
});
