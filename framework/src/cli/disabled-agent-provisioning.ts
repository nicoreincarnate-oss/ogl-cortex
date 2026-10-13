import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { randomUUID } from 'crypto';
import { dirname, join } from 'path';
import { validateAgentName, validateOrgName } from '../utils/validate.js';

export interface DisabledAgentSpec {
  identity: string;
  org: string;
  runtime: 'claude-code' | 'hermes' | 'codex-app-server' | 'opencode';
  template?: string;
  requestedModel?: string;
  requestedProfile?: string;
  resolvedModel?: string;
  resolvedEffort?: string;
  /** Concrete launch model written to config.model. */
  model?: string;
  /** Requested profile retained for legacy config readers. */
  profile?: string;
  seat?: string;
  pool?: string;
  lifecycle?: string;
  launchMode?: string;
}

export interface DisabledProvisionHooks {
  /** Test-only fault injection. Production callers must leave this unset. */
  beforeRename?: (spec: DisabledAgentSpec, index: number) => void;
}

export interface DisabledProvisionRequest {
  projectRoot: string;
  ctxRoot: string;
  specs: DisabledAgentSpec[];
  hooks?: DisabledProvisionHooks;
}

export interface DisabledProvisionResult {
  created: string[];
  registryPath: string;
}

interface RegistrySnapshot {
  existed: boolean;
  raw: string | null;
  value: Record<string, Record<string, unknown>>;
}

const RUNTIME_TEMPLATES: Record<DisabledAgentSpec['runtime'], string> = {
  'claude-code': 'agent',
  hermes: 'hermes',
  'codex-app-server': 'agent-codex',
  opencode: 'agent-opencode',
};

function readRegistryStrict(path: string): RegistrySnapshot {
  if (!existsSync(path)) {
    return { existed: false, raw: null, value: {} };
  }

  const raw = readFileSync(path, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Refusing disabled provisioning: registry is not valid JSON: ${path}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Refusing disabled provisioning: registry must be a JSON object: ${path}`);
  }
  for (const [identity, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Refusing disabled provisioning: registry entry "${identity}" must be an object: ${path}`);
    }
  }
  return {
    existed: true,
    raw,
    value: parsed as Record<string, Record<string, unknown>>,
  };
}

function assertRegistryUnchanged(path: string, snapshot: RegistrySnapshot): void {
  if (snapshot.existed !== existsSync(path)) {
    throw new Error(`Refusing disabled provisioning: registry changed during staging: ${path}`);
  }
  if (snapshot.existed && readFileSync(path, 'utf-8') !== snapshot.raw) {
    throw new Error(`Refusing disabled provisioning: registry changed during staging: ${path}`);
  }
}

function restoreRegistry(path: string, snapshot: RegistrySnapshot): void {
  if (snapshot.existed) {
    atomicWriteRawSync(path, snapshot.raw ?? '');
  } else if (existsSync(path)) {
    unlinkSync(path);
  }
}

function atomicWriteRawSync(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.tmp.disabled-provision-${randomUUID()}`);
  try {
    writeFileSync(temporary, data, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
}

function findTemplateDir(projectRoot: string, template: string): string | null {
  const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT || projectRoot;
  const candidates = [
    join(projectRoot, 'templates', template),
    join(frameworkRoot, 'templates', template),
    join(projectRoot, 'node_modules', 'cortextos', 'templates', template),
    join(__dirname, '..', '..', 'templates', template),
  ];
  return candidates.find(existsSync) ?? null;
}

function copyTemplateTree(source: string, destination: string, spec: DisabledAgentSpec): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory()) {
      copyTemplateTree(sourcePath, destinationPath, spec);
      continue;
    }
    if (!entry.isFile() && !statSync(sourcePath).isFile()) continue;
    let content = readFileSync(sourcePath, 'utf-8');
    content = content
      .replace(/\{\{agent_name\}\}/g, spec.identity)
      .replace(/\{\{org\}\}/g, spec.org)
      .replace(/\{\{current_timestamp\}\}/g, new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));
    writeFileSync(destinationPath, content, 'utf-8');
  }
}

function writeMinimalBootstrap(destination: string, spec: DisabledAgentSpec): void {
  const files: Record<string, string> = {
    'AGENTS.md': `# ${spec.identity}\n\nDisabled CortexOS agent for ${spec.org}.\n`,
    'IDENTITY.md': `# ${spec.identity}\n`,
    'SOUL.md': '# Soul\n\nBe precise, safe, and evidence-led.\n',
    'GOALS.md': '# Goals\n\n- Await activation authority\n',
    'HEARTBEAT.md': '# Heartbeat\n\nThis identity is disabled.\n',
    'MEMORY.md': '# Memory\n',
    'SYSTEM.md': `# System Context\n\nOrganization: ${spec.org}\n`,
    'TOOLS.md': '# Tools\n\nNo tools may run before activation.\n',
    'USER.md': '# User\n',
  };
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(destination, name), content, 'utf-8');
  }
}

function scaffoldDisabledAgent(
  stagingDir: string,
  finalDir: string,
  projectRoot: string,
  spec: DisabledAgentSpec,
): void {
  mkdirSync(stagingDir, { recursive: false });
  mkdirSync(join(stagingDir, 'memory'), { recursive: true });

  const templateName = spec.template ?? RUNTIME_TEMPLATES[spec.runtime];
  const templateDir = findTemplateDir(projectRoot, templateName);
  if (templateDir) {
    copyTemplateTree(templateDir, stagingDir, spec);
  } else if (spec.seat !== undefined) {
    throw new Error(`Required roster template "${templateName}" was not found for ${spec.seat}/${spec.identity}`);
  } else {
    writeMinimalBootstrap(stagingDir, spec);
  }

  if (spec.runtime !== 'codex-app-server' && spec.runtime !== 'opencode') {
    mkdirSync(join(stagingDir, '.claude', 'skills'), { recursive: true });
  }

  const goalsPath = join(stagingDir, 'goals.json');
  if (!existsSync(goalsPath)) {
    writeFileSync(goalsPath, JSON.stringify({
      focus: '', goals: [], bottleneck: '', updated_at: '', updated_by: '',
    }, null, 2) + '\n', 'utf-8');
  }

  const configPath = join(stagingDir, 'config.json');
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Template config is not an object for ${spec.identity}`);
    }
    config = parsed as Record<string, unknown>;
  }

  Object.assign(config, {
    agent_name: spec.identity,
    enabled: false,
    runtime: spec.runtime,
    telegram_polling: false,
    working_directory: finalDir,
  });
  if (spec.model !== undefined) config.model = spec.model;
  if (spec.profile !== undefined) config.profile = spec.profile;
  if (spec.requestedModel !== undefined) config.requested_model = spec.requestedModel;
  if (spec.requestedProfile !== undefined) config.requested_profile = spec.requestedProfile;
  if (spec.resolvedModel !== undefined) config.resolved_model = spec.resolvedModel;
  if (spec.resolvedEffort !== undefined) config.resolved_effort = spec.resolvedEffort;
  if (spec.seat !== undefined) config.harness_seat = spec.seat;
  if (spec.pool !== undefined) config.harness_pool = spec.pool;
  if (spec.lifecycle !== undefined) config.harness_lifecycle = spec.lifecycle;
  if (spec.launchMode !== undefined) config.harness_launch_mode = spec.launchMode;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

  // Deliberately do not write Telegram or provider variable names. Current
  // `enable` therefore fails closed until a later, explicit activation path.
  const envPath = join(stagingDir, '.env');
  writeFileSync(envPath, [
    `# Disabled-only provisioning for ${spec.identity}.`,
    '# No Telegram or provider credentials are installed.',
    '# Activation requires a separate validated command.',
    '',
  ].join('\n'), { encoding: 'utf-8', mode: 0o600 });
  chmodSync(envPath, 0o600);
}

interface ProvisionLock {
  path: string;
  fd: number;
  token: string;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function readLockRecord(path: string): { pid: number; token: string } | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (!Number.isSafeInteger(record.pid) || typeof record.token !== 'string' || !record.token) return null;
    return { pid: record.pid as number, token: record.token };
  } catch {
    return null;
  }
}

function unlinkOwnedLock(path: string, token: string): void {
  try {
    if (readLockRecord(path)?.token === token) unlinkSync(path);
  } catch { /* best effort; never unlink a lock we no longer own */ }
}

function reclaimStaleProvisionLock(path: string): void {
  const reclaimPath = `${path}.reclaim`;
  const reclaimToken = randomUUID();
  let reclaimFd: number;
  try {
    reclaimFd = openSync(reclaimPath, 'wx', 0o600);
  } catch {
    throw new Error(`Another disabled provisioning lock audit is active: ${reclaimPath}`);
  }
  let reclaimRecordWritten = false;
  try {
    writeFileSync(reclaimFd, JSON.stringify({
      pid: process.pid,
      token: reclaimToken,
      createdAt: new Date().toISOString(),
    }) + '\n');
    reclaimRecordWritten = true;
    if (!existsSync(path)) return;
    const record = readLockRecord(path);
    if (record && processIsAlive(record.pid)) {
      throw new Error(`Another disabled provisioning transaction is active: ${path} (pid ${record.pid})`);
    }
    if (!record) {
      const ageMs = Date.now() - statSync(path).mtimeMs;
      if (ageMs < 60_000) {
        throw new Error(`Disabled provisioning lock is incomplete but recent; refusing unsafe reclaim: ${path}`);
      }
    }
    unlinkSync(path);
  } finally {
    try { closeSync(reclaimFd); } catch { /* already closed */ }
    if (reclaimRecordWritten) unlinkOwnedLock(reclaimPath, reclaimToken);
    else {
      // The file is ours but may be empty if its initial write failed.
      try { unlinkSync(reclaimPath); } catch { /* best effort */ }
    }
  }
}

function createProvisionLock(path: string): ProvisionLock {
  const token = randomUUID();
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }) + '\n');
    return { path, fd, token };
  } catch (error) {
    try { closeSync(fd); } catch { /* best effort */ }
    try { unlinkSync(path); } catch { /* best effort */ }
    throw error;
  }
}

function acquireProvisionLock(ctxRoot: string): ProvisionLock {
  const configDir = join(ctxRoot, 'config');
  mkdirSync(configDir, { recursive: true });
  const path = join(configDir, '.agent-provision.lock');
  try {
    return createProvisionLock(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw error;
  }
  reclaimStaleProvisionLock(path);
  try {
    return createProvisionLock(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Another disabled provisioning transaction won the reclaim race: ${path}`);
    }
    throw error;
  }
}

function releaseProvisionLock(lock: ProvisionLock): void {
  try { closeSync(lock.fd); } catch { /* already closed */ }
  unlinkOwnedLock(lock.path, lock.token);
}

/**
 * Provision one or more identities without ever exposing an enabled agent.
 *
 * The disabled registry entries are atomically committed before any final
 * agent directory becomes visible. If a later rename fails, visible dirs are
 * moved back while the disabled registry remains in force, then the registry
 * snapshot is restored. This ordering is what prevents daemon discovery from
 * observing an unregistered directory and default-starting it.
 */
export function provisionDisabledAgents(request: DisabledProvisionRequest): DisabledProvisionResult {
  if (request.specs.length === 0) {
    return { created: [], registryPath: join(request.ctxRoot, 'config', 'enabled-agents.json') };
  }

  const identities = new Set<string>();
  const orgs = new Set<string>();
  for (const spec of request.specs) {
    validateAgentName(spec.identity);
    validateOrgName(spec.org);
    if (identities.has(spec.identity)) throw new Error(`Duplicate identity in provisioning batch: ${spec.identity}`);
    identities.add(spec.identity);
    orgs.add(spec.org);
  }
  if (orgs.size !== 1) throw new Error('A disabled provisioning transaction must target exactly one org');

  const org = request.specs[0].org;
  const agentsRoot = join(request.projectRoot, 'orgs', org, 'agents');
  mkdirSync(agentsRoot, { recursive: true });
  const finalDirs = new Map(request.specs.map(spec => [spec.identity, join(agentsRoot, spec.identity)]));
  for (const [identity, finalDir] of finalDirs) {
    if (existsSync(finalDir)) throw new Error(`Agent "${identity}" already exists at ${finalDir}`);
  }

  const lock = acquireProvisionLock(request.ctxRoot);
  const registryPath = join(request.ctxRoot, 'config', 'enabled-agents.json');
  const stageRoot = join(request.projectRoot, 'orgs', org, `.cortextos-roster-stage-${randomUUID()}`);
  const renamed: Array<{ stagingDir: string; finalDir: string }> = [];
  let registryCommitted = false;
  let registrySnapshot: RegistrySnapshot | null = null;
  try {
    registrySnapshot = readRegistryStrict(registryPath);
    for (const spec of request.specs) {
      if (Object.prototype.hasOwnProperty.call(registrySnapshot.value, spec.identity)) {
        throw new Error(`Registry already contains identity "${spec.identity}"`);
      }
    }

    mkdirSync(stageRoot, { recursive: false });
    for (const spec of request.specs) {
      const stagingDir = join(stageRoot, spec.identity);
      scaffoldDisabledAgent(stagingDir, finalDirs.get(spec.identity)!, request.projectRoot, spec);
    }

    assertRegistryUnchanged(registryPath, registrySnapshot);
    for (const [identity, finalDir] of finalDirs) {
      if (existsSync(finalDir)) {
        throw new Error(`Agent "${identity}" appeared during disabled provisioning: ${finalDir}`);
      }
    }
    const nextRegistry: Record<string, Record<string, unknown>> = { ...registrySnapshot.value };
    for (const spec of request.specs) {
      nextRegistry[spec.identity] = {
        enabled: false,
        status: 'configured',
        org: spec.org,
        runtime: spec.runtime,
        telegram_polling: false,
        ...(spec.model !== undefined ? { model: spec.model } : {}),
        ...(spec.profile !== undefined ? { profile: spec.profile } : {}),
        ...(spec.requestedModel !== undefined ? { requested_model: spec.requestedModel } : {}),
        ...(spec.requestedProfile !== undefined ? { requested_profile: spec.requestedProfile } : {}),
        ...(spec.resolvedModel !== undefined ? { resolved_model: spec.resolvedModel } : {}),
        ...(spec.resolvedEffort !== undefined ? { resolved_effort: spec.resolvedEffort } : {}),
        ...(spec.seat !== undefined ? { harness_seat: spec.seat } : {}),
      };
    }
    atomicWriteRawSync(registryPath, JSON.stringify(nextRegistry, null, 2) + '\n');
    registryCommitted = true;

    request.specs.forEach((spec, index) => {
      request.hooks?.beforeRename?.(spec, index);
      const stagingDir = join(stageRoot, spec.identity);
      const finalDir = finalDirs.get(spec.identity)!;
      if (existsSync(finalDir)) {
        throw new Error(`Agent "${spec.identity}" appeared before atomic reveal: ${finalDir}`);
      }
      renameSync(stagingDir, finalDir);
      renamed.push({ stagingDir, finalDir });
    });

    const committedRegistry = readRegistryStrict(registryPath).value;
    for (const spec of request.specs) {
      const finalDir = finalDirs.get(spec.identity)!;
      const config = JSON.parse(readFileSync(join(finalDir, 'config.json'), 'utf-8')) as Record<string, unknown>;
      const entry = committedRegistry[spec.identity];
      if (!entry || config.enabled !== false || entry.enabled !== false) {
        throw new Error(`Disabled provisioning postcondition failed for ${spec.identity}`);
      }
      if (config.runtime !== spec.runtime || entry.runtime !== spec.runtime) {
        throw new Error(`Runtime provisioning postcondition failed for ${spec.identity}`);
      }
      if (config.telegram_polling !== false || entry.telegram_polling !== false) {
        throw new Error(`Telegram provisioning postcondition failed for ${spec.identity}`);
      }
    }

    rmSync(stageRoot, { recursive: true, force: true });
    return { created: request.specs.map(spec => spec.identity), registryPath };
  } catch (error) {
    let rollbackError: Error | null = null;
    for (const entry of [...renamed].reverse()) {
      try {
        mkdirSync(dirname(entry.stagingDir), { recursive: true });
        renameSync(entry.finalDir, entry.stagingDir);
      } catch (candidate) {
        rollbackError = candidate as Error;
        break;
      }
    }

    // A concurrent legacy creator does not honor our lock. If any target path
    // remains visible after moving our own directories back, retaining the
    // disabled registry is safer than restoring an absent/enabled snapshot.
    const unexpectedVisible = [...finalDirs.entries()]
      .filter(([, finalDir]) => existsSync(finalDir))
      .map(([identity]) => identity);
    if (!rollbackError && unexpectedVisible.length > 0) {
      rollbackError = new Error(`target identities remain visible: ${unexpectedVisible.join(', ')}`);
    }

    if (!rollbackError && registryCommitted && registrySnapshot) {
      try {
        restoreRegistry(registryPath, registrySnapshot);
      } catch (candidate) {
        rollbackError = candidate as Error;
      }
    }
    rmSync(stageRoot, { recursive: true, force: true });

    if (rollbackError) {
      throw new Error(
        `Disabled provisioning failed and rollback was incomplete; registry remains disabled for safety. ` +
        `Cause: ${(error as Error).message}; rollback: ${rollbackError.message}`,
      );
    }
    throw error;
  } finally {
    releaseProvisionLock(lock);
  }
}
