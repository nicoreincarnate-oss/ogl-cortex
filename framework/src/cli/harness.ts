import { Command, InvalidArgumentError } from 'commander';
import { homedir } from 'os';
import { join } from 'path';
import { IPCClient } from '../daemon/ipc-server.js';
import {
  HarnessService,
  probeHarnessPreflight,
  type HarnessAction,
  type HarnessActionPayload,
} from '../harness/service.js';
import type { ProjectStatus } from '../harness/types.js';
import { discoverProjectRoot } from './enable-agent.js';

const PROJECT_STATUSES: readonly ProjectStatus[] = [
  'queued',
  'admitted',
  'paused',
  'completed',
  'cancelled',
];

interface HarnessCliOptions {
  instance?: string;
  org?: string;
}

function parsePriority(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
    throw new InvalidArgumentError('priority must be an integer from 0 through 100');
  }
  return parsed;
}

function parseProjectStatus(value: string): ProjectStatus {
  if (!PROJECT_STATUSES.includes(value as ProjectStatus)) {
    throw new InvalidArgumentError(`status must be one of: ${PROJECT_STATUSES.join(', ')}`);
  }
  return value as ProjectStatus;
}

function parseDueAt(value: string): number {
  const numeric = Number(value);
  const parsed = Number.isFinite(numeric) ? numeric : Date.parse(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidArgumentError('due must be an epoch-millisecond value or ISO-8601 timestamp');
  }
  return Math.trunc(parsed);
}

function context(command: Command): {
  instanceId: string;
  org: string;
  ctxRoot: string;
  frameworkRoot: string;
} {
  const options = command.optsWithGlobals() as HarnessCliOptions;
  const instanceId = options.instance || process.env.CTX_INSTANCE_ID || 'default';
  return {
    instanceId,
    org: options.org || process.env.CTX_ORG || 'atrium',
    ctxRoot: join(homedir(), '.cortextos', instanceId),
    frameworkRoot: discoverProjectRoot(),
  };
}

function output(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function run(
  action: HarnessAction,
  payload: HarnessActionPayload,
  command: Command,
): Promise<void> {
  const env = context(command);
  const ipc = new IPCClient(env.instanceId);
  const daemonRunning = await ipc.isDaemonRunning();

  if (daemonRunning) {
    const response = await ipc.send({
      type: 'harness',
      data: { action, payload },
      source: `cortextos harness ${action}`,
    });
    if (!response.success) throw new Error(response.error || 'Harness request failed');
    output({ success: true, transport: 'daemon', data: response.data });
    return;
  }

  if (action === 'preflight') {
    output({
      success: true,
      transport: 'offline',
      data: probeHarnessPreflight({
        ctxRoot: env.ctxRoot,
        frameworkRoot: env.frameworkRoot,
        org: env.org,
      }),
    });
    return;
  }

  // Only initialization and status are safe as one-shot operations. All
  // project mutations require the single long-running daemon writer.
  if (action !== 'init' && action !== 'status') {
    throw new Error(
      `Daemon is not running; '${action}' requires the daemon to avoid concurrent shadow-store writers. Start CortexOS first.`,
    );
  }

  const service = new HarnessService(env);
  try {
    const data = service.handle(action, payload);
    output({ success: true, transport: 'offline-one-shot', data });
  } finally {
    service.close();
  }
}

function safe(action: HarnessAction, payload: HarnessActionPayload, command: Command): Promise<void> {
  return run(action, payload, command).catch((error) => {
    console.error(JSON.stringify({
      success: false,
      action,
      error: error instanceof Error ? error.message : String(error),
    }, null, 2));
    process.exitCode = 1;
  });
}

export const harnessCommand = new Command('harness')
  .description('Operate the local 16-seat, four-project compatibility-shadow harness')
  .option('--instance <id>', 'CortexOS instance ID')
  .option('--org <org>', 'organization for optional compatibility bus projection');

harnessCommand.addCommand(new Command('init')
  .description('Initialize the shadow store and projection')
  .action((_options: unknown, command: Command) => safe('init', {}, command)));

harnessCommand.addCommand(new Command('status')
  .description('Show harness, preflight, slot, and control status')
  .action((_options: unknown, command: Command) => safe('status', {}, command)));

harnessCommand.addCommand(new Command('submit')
  .description('Submit a project to the deterministic four-slot queue')
  .argument('<title>', 'project title')
  .option('-d, --description <text>', 'project description', '')
  .option('--acceptance <text>', 'explicit acceptance criteria')
  .option('--repository <path>', 'canonical repository or project root')
  .option('--worktree <path>', 'isolated worktree or working directory')
  .option('--artifacts <paths>', 'expected artifact paths or deliverables')
  .option('-p, --priority <0-100>', 'queue priority', parsePriority, 50)
  .action((title: string, options: {
    description: string;
    acceptance?: string;
    repository?: string;
    worktree?: string;
    artifacts?: string;
    priority: number;
  }, command: Command) => safe('submit', {
    title,
    description: options.description,
    acceptanceCriteria: options.acceptance,
    repository: options.repository,
    worktree: options.worktree,
    artifactPaths: options.artifacts,
    priority: options.priority,
  }, command)));

harnessCommand.addCommand(new Command('list')
  .description('List projects')
  .option('--status <status>', 'filter by project status', parseProjectStatus)
  .action((options: { status?: ProjectStatus }, command: Command) =>
    safe('list', { status: options.status }, command)));

harnessCommand.addCommand(new Command('show')
  .description('Show one project, its workflow nodes, and human requests')
  .argument('<project-id>', 'project ID')
  .action((projectId: string, _options: unknown, command: Command) =>
    safe('show', { projectId }, command)));

harnessCommand.addCommand(new Command('tick')
  .description('Run one deterministic scheduler tick')
  .action((_options: unknown, command: Command) => safe('tick', {}, command)));

for (const action of ['pause', 'resume', 'cancel'] as const) {
  harnessCommand.addCommand(new Command(action)
    .description(`${action} a project`)
    .argument('<project-id>', 'project ID')
    .action((projectId: string, _options: unknown, command: Command) =>
      safe(action, { projectId }, command)));
}

harnessCommand.addCommand(new Command('human')
  .description('Create a human action request attached to a project')
  .argument('<project-id>', 'project ID')
  .argument('<title>', 'request title')
  .option('-d, --description <text>', 'request details', '')
  .option('--assigned-to <identity>', 'human owner')
  .option('--due <timestamp>', 'epoch milliseconds or ISO-8601', parseDueAt)
  .action((
    projectId: string,
    title: string,
    options: { description: string; assignedTo?: string; due?: number },
    command: Command,
  ) => safe('human', {
    projectId,
    title,
    description: options.description,
    assignedTo: options.assignedTo,
    dueAtMs: options.due,
  }, command)));

harnessCommand.addCommand(new Command('resolve')
  .description('Resolve a human action request')
  .argument('<request-id>', 'human request ID')
  .argument('<response>', 'resolution response')
  .action((requestId: string, response: string, _options: unknown, command: Command) =>
    safe('resolve', { requestId, response }, command)));

for (const [commandName, action] of [
  ['node-complete', 'node-complete'],
  ['node-fail', 'node-fail'],
] as const) {
  harnessCommand.addCommand(new Command(commandName)
    .description(`${commandName === 'node-complete' ? 'Complete' : 'Fail'} a ready node in manual shadow mode`)
    .argument('<project-id>', 'project ID')
    .argument('<node-key>', 'deterministic workflow node key')
    .requiredOption('--output <text>', 'bounded result or failure summary')
    .action((
      projectId: string,
      nodeKey: string,
      options: { output: string },
      command: Command,
    ) => safe(action, { projectId, nodeKey, output: options.output }, command)));
}

harnessCommand.addCommand(new Command('preflight')
  .description('Report Node, disk, and immutable production-control gates')
  .action((_options: unknown, command: Command) => safe('preflight', {}, command)));
