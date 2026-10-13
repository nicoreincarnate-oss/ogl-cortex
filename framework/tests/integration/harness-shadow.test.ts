import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeTask, createTask, updateTask } from '../../src/bus/task.js';
import { IPCClient, IPCServer } from '../../src/daemon/ipc-server.js';
import type { AgentManager } from '../../src/daemon/agent-manager.js';
import {
  HARNESS_MINIMUM_FREE_DISK_BYTES,
  HarnessService,
} from '../../src/harness/service.js';
import { COMPATIBILITY_BLOCK_TIMEOUT_MS, SHADOW_WORKFLOW, alignSignoffRequestId } from '../../src/harness/scheduler.js';
import { SHADOW_ROSTER } from '../../src/harness/roster.js';
import { resolvePaths } from '../../src/utils/paths.js';

const NODE_MAJOR = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
const describeNode26 = NODE_MAJOR >= 26 ? describe : describe.skip;
const cleanupPaths: string[] = [];

function tempRoot(prefix = 'cortex-harness-'): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  cleanupPaths.push(path);
  return path;
}

function createService(ctxRoot = tempRoot(), overrides: Partial<ConstructorParameters<typeof HarnessService>[0]> = {}) {
  return new HarnessService({
    instanceId: `test-${randomUUID().slice(0, 8)}`,
    ctxRoot,
    frameworkRoot: process.cwd(),
    org: 'atrium',
    diskAvailableBytesOverride: HARNESS_MINIMUM_FREE_DISK_BYTES + 1,
    ...overrides,
  });
}

function resolvedModel(desiredModel: string): string {
  if (desiredModel === 'fable-5') return 'claude-fable-5[1m]';
  if (desiredModel === 'opus-4.8') return 'claude-opus-4-8[1m]';
  return 'claude-sonnet-5-5';
}

function enableCompatibilityHosts(ctxRoot: string, frameworkRoot = ctxRoot): void {
  const configDir = join(ctxRoot, 'config');
  mkdirSync(configDir, { recursive: true });
  const enabled = Object.fromEntries(SHADOW_ROSTER.map((seat) => [
    seat.physicalAgent,
    { enabled: true, status: 'configured', org: 'atrium' },
  ]));
  writeFileSync(join(configDir, 'enabled-agents.json'), JSON.stringify(enabled));
  for (const seat of SHADOW_ROSTER) {
    const agentDir = join(frameworkRoot, 'orgs', 'atrium', 'agents', seat.physicalAgent);
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({
      agent_name: seat.physicalAgent,
      enabled: true,
      telegram_polling: false,
      runtime: seat.desiredRuntime,
      model: resolvedModel(seat.desiredModel),
      profile: seat.desiredProfile,
    }));
  }
}

function runningCompatibilityHost(physicalAgent: string) {
  const seat = SHADOW_ROSTER.find((candidate) => candidate.physicalAgent === physicalAgent);
  return seat ? {
    status: 'running',
    pid: 10_000 + SHADOW_ROSTER.indexOf(seat),
    model: resolvedModel(seat.desiredModel),
    bootstrapped: true,
    pidLiveVerified: true,
    actualModelVerified: true,
    sessionId: `session-${seat.logicalSeat}`,
    freshSessionCapable: true,
    completionAttestationCapable: true,
  } : null;
}

afterEach(() => {
  vi.useRealTimers();
  while (cleanupPaths.length > 0) {
    rmSync(cleanupPaths.pop()!, { recursive: true, force: true });
  }
});


/** Walk a freshly submitted project through Align and its human sign-off, so the plan becomes ready. */
function passAlign(host: HarnessService, projectId: string): void {
  const align = host.store.listNodes(projectId).find((node) => node.nodeKey === 'fable-align');
  if (!align) return; // queued, not materialized yet
  if (align.busTaskId) {
    // dispatch-enabled: Align was projected to a real bus task holding the fable seat; complete it the real way
    const instanceId = (host as unknown as { options: { instanceId: string } }).options.instanceId;
    completeTask(resolvePaths('harness', instanceId, 'atrium'), align.busTaskId, 'Alignment files accepted');
  } else {
    host.store.updateNode(align.id, { status: 'running' });
    host.store.updateNode(align.id, { status: 'completed', outputSummary: 'Alignment files accepted' });
  }
  host.tick();
  host.store.resolveHumanRequest(alignSignoffRequestId(projectId), { response: 'Numbered needs signed off' });
  host.tick();
}

function submitAligned(host: HarnessService, input: Parameters<HarnessService['submit']>[0]) {
  const project = host.submit(input);
  passAlign(host, project.id);
  return project;
}

describeNode26('compatibility-shadow harness integration', () => {
  it('admits at most four projects and materializes the exact deterministic eleven-node graph (Align first)', () => {
    const service = createService();
    try {
      const initialized = service.initialize();
      expect(initialized.control).toEqual({
        dispatch_enabled: false,
        egress_enabled: false,
        spend_enabled: false,
        provisioning_enabled: false,
        compatibility_bus_projection_enabled: false,
      });
      expect(service.store.getStatus().rosterSeatCount).toBe(16);
      expect(service.store.getStatus().slots).toHaveLength(4);

      for (let index = 1; index <= 5; index += 1) {
        service.submit({
          title: `Live project ${index}`,
          description: `Project ${index} acceptance packet`,
          priority: 50,
        });
      }

      const admitted = service.store.listProjects({ status: 'admitted' });
      const queued = service.store.listProjects({ status: 'queued' });
      expect(admitted).toHaveLength(4);
      expect(queued).toHaveLength(1);
      expect(service.store.getStatus().activeProjectCount).toBe(4);

      for (const project of admitted) {
        const nodes = service.store.listNodes(project.id);
        expect(nodes).toHaveLength(11);
        expect(nodes.map((node) => node.nodeKey)).toEqual(SHADOW_WORKFLOW.map((stage) => stage.key));

        const byKey = new Map(nodes.map((node) => [node.nodeKey, node]));
        expect(byKey.get('fable-align')?.status).toBe('ready');
        expect(byKey.get('fable-align')?.assignedSeat).toBe(`f${project.slotNo}`);
        expect(byKey.get('fable-plan')?.status).toBe('pending');
        expect(byKey.get('fable-plan')?.dependsOn).toEqual([byKey.get('fable-align')?.id]);
        expect(byKey.get('fable-plan')?.assignedSeat).toBe(`f${project.slotNo}`);
        expect(byKey.get('sonnet-critique-a')?.dependsOn).toEqual([byKey.get('fable-plan')?.id]);
        expect(byKey.get('sonnet-critique-b')?.dependsOn).toEqual([byKey.get('fable-plan')?.id]);
        expect(byKey.get('fable-revision')?.dependsOn).toEqual([
          byKey.get('sonnet-critique-a')?.id,
          byKey.get('sonnet-critique-b')?.id,
        ]);
        expect(byKey.get('sonnet-correction')?.dependsOn).toEqual([
          byKey.get('fable-correction')?.id,
        ]);
        expect(byKey.get('sonnet-correction')?.assignedSeat).toBe(
          byKey.get('sonnet-build')?.assignedSeat,
        );
        expect(byKey.get('o3-final-review')?.dependsOn).toEqual([
          byKey.get('sonnet-correction')?.id,
        ]);
        expect(byKey.get('o3-final-review')?.assignedSeat).toBe('o3');
      }
      expect(service.store.listNodes(queued[0].id)).toHaveLength(0);
    } finally {
      service.close();
    }
  });

  it('Align gate: completing Align opens one sign-off request to the operator and the plan waits for its resolution', () => {
    const service = createService();
    try {
      const project = service.submit({ title: 'Align gate project' });
      let nodes = service.store.listNodes(project.id);
      const align = nodes.find((node) => node.nodeKey === 'fable-align')!;
      expect(align.status).toBe('ready');
      service.store.updateNode(align.id, { status: 'running' });
      service.store.updateNode(align.id, { status: 'completed', outputSummary: 'seven files' });
      service.tick();
      const requests = service.store.listHumanRequests(project.id);
      expect(requests).toHaveLength(1);
      expect(requests[0].id).toBe(alignSignoffRequestId(project.id));
      expect(requests[0].assignedTo).toBe('operator');
      expect(requests[0].status).toBe('open');
      nodes = service.store.listNodes(project.id);
      const waitingPlan = nodes.find((node) => node.nodeKey === 'fable-plan')!;
      expect(waitingPlan.status).toBe('blocked'); // the store promotes it on Align completion; the gate holds it
      expect(waitingPlan.outputSummary).toContain(alignSignoffRequestId(project.id));
      expect(waitingPlan.busTaskId).toBeFalsy();
      service.tick();
      expect(service.store.listHumanRequests(project.id)).toHaveLength(1); // idempotent, never a second request
      service.store.resolveHumanRequest(alignSignoffRequestId(project.id), { response: 'signed' });
      service.tick();
      expect(service.store.listNodes(project.id).find((node) => node.nodeKey === 'fable-plan')?.status).toBe('ready');
    } finally {
      service.close();
    }
  });

  it('Align gate in dispatch mode: the plan never gets a task before the sign-off is resolved', () => {
    const instanceId = `harness-align-${randomUUID().slice(0, 8)}`;
    const ctxRoot = join(homedir(), '.cortextos', instanceId);
    cleanupPaths.push(ctxRoot);
    enableCompatibilityHosts(ctxRoot);
    const service = new HarnessService({
      instanceId, ctxRoot, frameworkRoot: ctxRoot, org: 'atrium',
      compatibilityDispatchRequested: true,
      diskAvailableBytesOverride: HARNESS_MINIMUM_FREE_DISK_BYTES + 1,
      agentRuntimeStatus: runningCompatibilityHost,
    });
    try {
      const project = service.submit({ title: 'Dispatch align project' });
      const paths = resolvePaths('harness', instanceId, 'atrium');
      const align = service.store.listNodes(project.id).find((node) => node.nodeKey === 'fable-align')!;
      expect(align.status).toBe('dispatched');
      completeTask(paths, align.busTaskId!, 'seven files');
      service.tick();
      service.tick();
      const plan = service.store.listNodes(project.id).find((node) => node.nodeKey === 'fable-plan')!;
      expect(plan.busTaskId).toBeFalsy();
      expect(service.store.listHumanRequests(project.id).map((r) => r.status)).toEqual(['open']);
      service.store.resolveHumanRequest(alignSignoffRequestId(project.id), { response: 'signed' });
      service.tick();
      const released = service.store.listNodes(project.id).find((node) => node.nodeKey === 'fable-plan')!;
      expect(released.status).toBe('dispatched');
      expect(released.busTaskId).toBeTruthy();
    } finally {
      service.close();
    }
  });

  it('Align gate: a cancelled sign-off stops the project and never unlocks the plan', () => {
    const service = createService();
    try {
      const project = service.submit({ title: 'Align rejected project' });
      const align = service.store.listNodes(project.id).find((node) => node.nodeKey === 'fable-align')!;
      service.store.updateNode(align.id, { status: 'running' });
      service.store.updateNode(align.id, { status: 'completed', outputSummary: 'seven files' });
      service.tick();
      service.store.resolveHumanRequest(alignSignoffRequestId(project.id), { status: 'cancelled', response: 'needs are wrong' });
      const result = service.tick();
      expect(result.failed_project_ids).toContain(project.id);
      expect(service.store.listProjects({ status: 'admitted' }).map((p) => p.id)).not.toContain(project.id);
      expect(service.store.listNodes(project.id).find((node) => node.nodeKey === 'fable-plan')?.status).not.toBe('ready');
    } finally {
      service.close();
    }
  });

  it('Align gate: a project that already has a plan node never gets an Align stage', () => {
    const service = createService();
    try {
      service.initialize();
      const legacy = service.store.createProject({ title: 'Pre-Align project' });
      service.store.admitProject(legacy.id);
      service.store.createNode({
        id: `${legacy.id}:node:01`, projectId: legacy.id, nodeKey: 'fable-plan', name: 'Fable plan',
        kind: 'planning', requiredPool: 'fable', assignedSeat: null, dependsOn: [], inputSummary: '{}',
      });
      service.tick();
      const nodes = service.store.listNodes(legacy.id);
      expect(nodes.some((node) => node.nodeKey === 'fable-align')).toBe(false);
      expect(nodes).toHaveLength(10);
      expect(nodes.find((node) => node.nodeKey === 'fable-plan')?.status).toBe('ready');
      expect(service.store.listHumanRequests(legacy.id)).toHaveLength(0);
    } finally {
      service.close();
    }
  });

  it('recovers graph state and projection sequence across a service restart', () => {
    const ctxRoot = tempRoot();
    const options = {
      instanceId: `restart-${randomUUID().slice(0, 8)}`,
      ctxRoot,
      frameworkRoot: ctxRoot,
      org: 'atrium',
      diskAvailableBytesOverride: HARNESS_MINIMUM_FREE_DISK_BYTES + 1,
      agentRuntimeStatus: runningCompatibilityHost,
    } as const;

    const first = new HarnessService(options);
    const project = submitAligned(first, { title: 'Restart-safe project', priority: 80 });
    const plan = first.store.listNodes(project.id).find((node) => node.nodeKey === 'fable-plan')!;
    first.store.updateNode(plan.id, { status: 'running' });
    first.store.updateNode(plan.id, { status: 'completed', outputSummary: 'Accepted plan packet' });
    first.tick();

    const projectionPath = join(ctxRoot, 'harness', 'projection.json');
    const before = JSON.parse(readFileSync(projectionPath, 'utf-8')) as {
      projection_sequence: number;
    };
    first.close();

    const second = new HarnessService(options);
    try {
      second.initialize();
      const nodes = second.store.listNodes(project.id);
      expect(nodes.find((node) => node.nodeKey === 'fable-plan')?.status).toBe('completed');
      expect(nodes.find((node) => node.nodeKey === 'sonnet-critique-a')?.status).toBe('ready');
      expect(nodes.find((node) => node.nodeKey === 'sonnet-critique-b')?.status).toBe('ready');
      expect(nodes).toHaveLength(11);

      const after = JSON.parse(readFileSync(projectionPath, 'utf-8')) as {
        schema_id: string;
        projection_sequence: number;
        control: Record<string, unknown>;
        snapshot: { productionAuthoritative: boolean; projects: unknown[]; roster: unknown[] };
      };
      expect(after.schema_id).toBe('cortex-harness-shadow-projection/v1');
      expect(after.projection_sequence).toBeGreaterThan(before.projection_sequence);
      expect(after.control).toMatchObject({
        dispatch_enabled: false,
        egress_enabled: false,
        spend_enabled: false,
        provisioning_enabled: false,
      });
      expect(after.snapshot.productionAuthoritative).toBe(false);
      expect(after.snapshot.projects).toHaveLength(1);
      expect(after.snapshot.roster).toHaveLength(16);
      expect(readFileSync(projectionPath, 'utf-8')).not.toContain('databasePath');
    } finally {
      second.close();
    }
  });

  it('keeps base shadow storage usable while refusing compatibility projection below 20 GiB', () => {
    const service = createService(undefined, {
      compatibilityDispatchRequested: true,
      diskAvailableBytesOverride: HARNESS_MINIMUM_FREE_DISK_BYTES - 1,
    });
    try {
      const preflight = service.preflight();
      expect(preflight.supported).toBe(true);
      expect(preflight.shadow_base_usable).toBe(true);
      expect(preflight.ready).toBe(false);
      expect(preflight.blocker_count).toBeGreaterThan(1);
      expect(preflight.blockers.some((blocker) => blocker.startsWith('free-disk-'))).toBe(true);
      expect(preflight.compatibility_bus_projection).toMatchObject({
        requested: true,
        effective: false,
      });

      service.initialize();
      const project = submitAligned(service, { title: 'Disk-gated project' });
      expect(service.store.listNodes(project.id).find((node) => node.nodeKey === 'fable-plan')?.status)
        .toBe('ready');
    } finally {
      service.close();
    }
  });

  it('refuses the compatibility bridge when mapped workflow hosts are disabled or absent', () => {
    const service = createService(undefined, { compatibilityDispatchRequested: true });
    try {
      const preflight = service.preflight();
      expect(preflight.node.satisfied).toBe(true);
      expect(preflight.disk.satisfied).toBe(true);
      expect(preflight.compatibility_hosts.required_seat_count).toBe(15);
      expect(preflight.compatibility_hosts.satisfied).toBe(false);
      expect(preflight.ready).toBe(false);
      expect(preflight.compatibility_bus_projection.effective).toBe(false);
      expect(preflight.blockers).toContain('enabled-agent-config-missing-or-invalid');
    } finally {
      service.close();
    }
  });

  it('recovers an existing compatibility task after the create-task/database crash window', () => {
    const instanceId = `harness-recovery-${randomUUID().slice(0, 8)}`;
    const ctxRoot = join(homedir(), '.cortextos', instanceId);
    cleanupPaths.push(ctxRoot);
    enableCompatibilityHosts(ctxRoot);
    const common = {
      instanceId,
      ctxRoot,
      frameworkRoot: ctxRoot,
      org: 'atrium',
      diskAvailableBytesOverride: HARNESS_MINIMUM_FREE_DISK_BYTES + 1,
      agentRuntimeStatus: runningCompatibilityHost,
    } as const;

    const shadowOnly = new HarnessService({ ...common, compatibilityDispatchRequested: false });
    const project = submitAligned(shadowOnly, { title: 'Crash-window project' });
    const plan = shadowOnly.store.listNodes(project.id).find((node) => node.nodeKey === 'fable-plan')!;
    shadowOnly.close();

    const paths = resolvePaths('harness', instanceId, 'atrium');
    const preexistingTaskId = createTask(paths, 'harness', 'atrium', 'Recovered compatibility task', {
      assignee: 'f1',
      project: project.id,
      description: `Harness node: ${plan.id} (fable-plan)\nCreated before durable node binding`,
    });
    expect(readdirSync(paths.taskDir).filter((name) => name.endsWith('.json'))).toHaveLength(1);

    const recovered = new HarnessService({ ...common, compatibilityDispatchRequested: true });
    try {
      recovered.initialize();
      const recoveredPlan = recovered.store.listNodes(project.id)
        .find((node) => node.nodeKey === 'fable-plan')!;
      expect(recoveredPlan.status).toBe('dispatched');
      expect(recoveredPlan.busTaskId).toBe(preexistingTaskId);
      expect(readdirSync(paths.taskDir).filter((name) => name.endsWith('.json'))).toHaveLength(1);
      expect(recovered.store.listLeases({ projectId: project.id, status: 'active' }))
        .toEqual([expect.objectContaining({ nodeId: plan.id, logicalSeat: 'f1' })]);

      recovered.tick();
      expect(readdirSync(paths.taskDir).filter((name) => name.endsWith('.json'))).toHaveLength(1);

      updateTask(paths, preexistingTaskId, 'in_progress');
      recovered.tick();
      expect(recovered.store.listNodes(project.id).find((node) => node.id === plan.id)?.status)
        .toBe('running');

      completeTask(paths, preexistingTaskId, 'Plan accepted; token=do-not-project-this');
      const completionTick = recovered.tick();
      const completedPlan = recovered.store.listNodes(project.id).find((node) => node.id === plan.id)!;
      expect(completedPlan.status).toBe('completed');
      expect(completedPlan.outputSummary).toContain('token=[redacted]');
      expect(completedPlan.outputSummary).not.toContain('do-not-project-this');
      expect(completionTick.compatibility_reconciled_node_ids).toContain(plan.id);
      expect(recovered.store.listLeases({ projectId: project.id })
        .find((lease) => lease.nodeId === plan.id)?.status).toBe('released');
      // Both blind critiques become ready and receive distinct Codex leases/tasks.
      expect(readdirSync(paths.taskDir).filter((name) => name.endsWith('.json'))).toHaveLength(3);
      expect(recovered.store.listLeases({ projectId: project.id, status: 'active' })).toHaveLength(2);
    } finally {
      recovered.close();
    }
  });

  it('advances and completes a full project through explicit manual shadow node results', () => {
    const service = createService();
    try {
      const project = submitAligned(service, { title: 'Manual shadow project' });
      for (const stage of SHADOW_WORKFLOW) {
        const response = service.completeNode({
          projectId: project.id,
          nodeKey: stage.key,
          output: `${stage.key} accepted`,
        });
        expect(response.node).toMatchObject({ nodeKey: stage.key, status: 'completed' });
      }
      expect(service.store.getProject(project.id)?.status).toBe('completed');
      expect(service.store.getStatus().activeProjectCount).toBe(0);
      expect(service.store.listNodes(project.id).every((node) => node.status === 'completed')).toBe(true);
    } finally {
      service.close();
    }
  });

  it('blocks a missing compatibility task without creating a duplicate', () => {
    const instanceId = `harness-missing-${randomUUID().slice(0, 8)}`;
    const ctxRoot = join(homedir(), '.cortextos', instanceId);
    cleanupPaths.push(ctxRoot);
    enableCompatibilityHosts(ctxRoot);
    const service = new HarnessService({
      instanceId,
      ctxRoot,
      frameworkRoot: ctxRoot,
      org: 'atrium',
      compatibilityDispatchRequested: true,
      diskAvailableBytesOverride: HARNESS_MINIMUM_FREE_DISK_BYTES + 1,
      agentRuntimeStatus: runningCompatibilityHost,
    });
    try {
      const project = submitAligned(service, { title: 'Missing task project' });
      const plan = service.store.listNodes(project.id).find((node) => node.nodeKey === 'fable-plan')!;
      const paths = resolvePaths('harness', instanceId, 'atrium');
      expect(plan.status).toBe('dispatched');
      expect(plan.busTaskId).toBeTruthy();
      rmSync(join(paths.taskDir, `${plan.busTaskId}.json`));

      service.tick();
      const blocked = service.store.listNodes(project.id).find((node) => node.id === plan.id)!;
      expect(blocked.status).toBe('blocked');
      expect(blocked.busTaskId).toBe(plan.busTaskId);
      expect(blocked.outputSummary).toMatch(/missing/i);
      // Align's completed task file legitimately remains; the claim is that no duplicate plan task appears.
      const alignTaskFile = `${service.store.listNodes(project.id).find((node) => node.nodeKey === 'fable-align')!.busTaskId}.json`;
      const otherTasks = () => readdirSync(paths.taskDir).filter((name) => name.endsWith('.json') && name !== alignTaskFile);
      expect(otherTasks()).toHaveLength(0);

      service.tick();
      expect(otherTasks()).toHaveLength(0);

      vi.useFakeTimers({ now: blocked.updatedAtMs + COMPATIBILITY_BLOCK_TIMEOUT_MS + 1 });
      service.tick();
      expect(service.store.getProject(project.id)?.status).toBe('cancelled');
      expect(service.store.listNodes(project.id).find((node) => node.id === plan.id)?.status).toBe('failed');
    } finally {
      service.close();
    }
  });

  it('projects dependency-closed evidence while preserving blind critique isolation', () => {
    const instanceId = `harness-packet-${randomUUID().slice(0, 8)}`;
    const ctxRoot = join(homedir(), '.cortextos', instanceId);
    cleanupPaths.push(ctxRoot);
    enableCompatibilityHosts(ctxRoot);
    const service = new HarnessService({
      instanceId,
      ctxRoot,
      frameworkRoot: ctxRoot,
      org: 'atrium',
      compatibilityDispatchRequested: true,
      diskAvailableBytesOverride: HARNESS_MINIMUM_FREE_DISK_BYTES + 1,
      agentRuntimeStatus: runningCompatibilityHost,
    });
    try {
      const project = submitAligned(service, {
        title: 'Evidence packet project',
        description: 'Build the local widget without external effects.',
        acceptanceCriteria: 'Unit tests pass and widget.json exists.',
        repository: '/repo/widget',
        artifactPaths: 'widget.json',
      });
      const paths = resolvePaths('harness', instanceId, 'atrium');
      let nodes = service.store.listNodes(project.id);
      const plan = nodes.find((node) => node.nodeKey === 'fable-plan')!;
      const planTask = JSON.parse(readFileSync(join(paths.taskDir, `${plan.busTaskId}.json`), 'utf-8'));
      expect(planTask.description).toContain('Build the local widget');
      expect(planTask.description).toContain('Unit tests pass and widget.json exists.');
      expect(planTask.description).toContain('/repo/widget');

      completeTask(paths, plan.busTaskId!, 'PLAN-EVIDENCE-ALPHA');
      service.tick();
      nodes = service.store.listNodes(project.id);
      const critiqueA = nodes.find((node) => node.nodeKey === 'sonnet-critique-a')!;
      const critiqueB = nodes.find((node) => node.nodeKey === 'sonnet-critique-b')!;
      const critiqueBTask = JSON.parse(
        readFileSync(join(paths.taskDir, `${critiqueB.busTaskId}.json`), 'utf-8'),
      );
      expect(critiqueBTask.description).toContain('PLAN-EVIDENCE-ALPHA');
      expect(critiqueBTask.description).not.toContain('CRITIQUE-A-SECRET');

      completeTask(paths, critiqueA.busTaskId!, 'CRITIQUE-A-SECRET');
      service.tick();
      // B was already projected from the plan-only packet; completing A later
      // must not retroactively pierce the blind sibling boundary.
      const critiqueBAfter = JSON.parse(
        readFileSync(join(paths.taskDir, `${critiqueB.busTaskId}.json`), 'utf-8'),
      );
      expect(critiqueBAfter.description).not.toContain('CRITIQUE-A-SECRET');

      completeTask(paths, critiqueB.busTaskId!, 'CRITIQUE-B-EVIDENCE');
      service.tick();
      const revision = service.store.listNodes(project.id)
        .find((node) => node.nodeKey === 'fable-revision')!;
      const revisionTask = JSON.parse(
        readFileSync(join(paths.taskDir, `${revision.busTaskId}.json`), 'utf-8'),
      );
      expect(revisionTask.description).toContain('PLAN-EVIDENCE-ALPHA');
      expect(revisionTask.description).toContain('CRITIQUE-A-SECRET');
      expect(revisionTask.description).toContain('CRITIQUE-B-EVIDENCE');
    } finally {
      service.close();
    }
  });

  it('turns human requests into a durable project gate and idempotent continuation packet', () => {
    const instanceId = `harness-human-${randomUUID().slice(0, 8)}`;
    const ctxRoot = join(homedir(), '.cortextos', instanceId);
    cleanupPaths.push(ctxRoot);
    enableCompatibilityHosts(ctxRoot);
    const service = new HarnessService({
      instanceId,
      ctxRoot,
      frameworkRoot: ctxRoot,
      org: 'atrium',
      compatibilityDispatchRequested: true,
      diskAvailableBytesOverride: HARNESS_MINIMUM_FREE_DISK_BYTES + 1,
      agentRuntimeStatus: runningCompatibilityHost,
    });
    try {
      const project = submitAligned(service, { title: 'Human-gated project', description: 'Use the approved retention window.' });
      const paths = resolvePaths('harness', instanceId, 'atrium');
      const plan = service.store.listNodes(project.id).find((node) => node.nodeKey === 'fable-plan')!;
      updateTask(paths, plan.busTaskId!, 'in_progress');
      service.tick();

      const request = service.createHumanRequest({
        projectId: project.id,
        title: 'Choose retention',
        description: 'Select the exact retention window.',
      });
      const secondRequest = service.createHumanRequest({
        projectId: project.id,
        title: 'Choose region',
        description: 'Select the storage region.',
      });
      expect(service.store.listNodes(project.id).find((node) => node.id === plan.id)?.status).toBe('blocked');
      let task = JSON.parse(readFileSync(join(paths.taskDir, `${plan.busTaskId}.json`), 'utf-8'));
      expect(task.status).toBe('blocked');

      service.resolveHumanRequest({ requestId: request.id, response: 'Use 30 days.' });
      task = JSON.parse(readFileSync(join(paths.taskDir, `${plan.busTaskId}.json`), 'utf-8'));
      expect(task.status).toBe('blocked');
      expect(task.description).toContain('Use 30 days.');

      service.resolveHumanRequest({ requestId: secondRequest.id, response: 'Use us-west-2.' });
      service.resolveHumanRequest({ requestId: request.id, response: 'Use 30 days.' });
      task = JSON.parse(readFileSync(join(paths.taskDir, `${plan.busTaskId}.json`), 'utf-8'));
      expect(task.status).toBe('pending');
      expect(task.description.match(new RegExp(`harness-human-response:${request.id}`, 'g'))).toHaveLength(1);
      expect(task.description).toContain('Use 30 days.');
      expect(task.description).toContain('Use us-west-2.');
      expect(service.store.listNodes(project.id).find((node) => node.id === plan.id)?.status).toBe('dispatched');
    } finally {
      service.close();
    }
  });

  it('rejects a worker completion that races an open human gate', () => {
    const instanceId = `harness-human-race-${randomUUID().slice(0, 8)}`;
    const ctxRoot = join(homedir(), '.cortextos', instanceId);
    cleanupPaths.push(ctxRoot);
    enableCompatibilityHosts(ctxRoot);
    const service = new HarnessService({
      instanceId,
      ctxRoot,
      frameworkRoot: ctxRoot,
      org: 'atrium',
      compatibilityDispatchRequested: true,
      diskAvailableBytesOverride: HARNESS_MINIMUM_FREE_DISK_BYTES + 1,
      agentRuntimeStatus: runningCompatibilityHost,
    });
    try {
      const project = submitAligned(service, { title: 'Human race project' });
      const plan = service.store.listNodes(project.id).find((node) => node.nodeKey === 'fable-plan')!;
      const paths = resolvePaths('harness', instanceId, 'atrium');
      service.createHumanRequest({ projectId: project.id, title: 'Stop before completion' });
      completeTask(paths, plan.busTaskId!, 'This completion raced the gate.');

      service.tick();
      expect(service.store.getProject(project.id)?.status).toBe('cancelled');
      expect(service.store.listNodes(project.id).find((node) => node.id === plan.id)).toMatchObject({
        status: 'failed',
        outputSummary: expect.stringContaining('human-gate-violation'),
      });
    } finally {
      service.close();
    }
  });

  it('revalidates runtime health every tick and still reconciles already-bound work', () => {
    const instanceId = `harness-readiness-${randomUUID().slice(0, 8)}`;
    const ctxRoot = join(homedir(), '.cortextos', instanceId);
    cleanupPaths.push(ctxRoot);
    enableCompatibilityHosts(ctxRoot);
    let unavailable: string | null = null;
    const runtimeProbe = (physicalAgent: string) => physicalAgent === unavailable
      ? null
      : runningCompatibilityHost(physicalAgent);
    const service = new HarnessService({
      instanceId,
      ctxRoot,
      frameworkRoot: ctxRoot,
      org: 'atrium',
      compatibilityDispatchRequested: true,
      diskAvailableBytesOverride: HARNESS_MINIMUM_FREE_DISK_BYTES + 1,
      agentRuntimeStatus: runtimeProbe,
    });
    try {
      const first = submitAligned(service, { title: 'Already bound project' });
      const firstPlan = service.store.listNodes(first.id).find((node) => node.nodeKey === 'fable-plan')!;
      expect(firstPlan.status).toBe('dispatched');

      unavailable = 'f2';
      const second = submitAligned(service, { title: 'Readiness falling-edge project' });
      const secondPlan = service.store.listNodes(second.id).find((node) => node.nodeKey === 'fable-plan')!;
      expect(secondPlan.status).toBe('ready');
      expect(secondPlan.busTaskId).toBeNull();
      expect(service.status().control).toMatchObject({ compatibility_bus_projection_enabled: false });

      const paths = resolvePaths('harness', instanceId, 'atrium');
      completeTask(paths, firstPlan.busTaskId!, 'Completed after readiness fell closed.');
      service.tick();
      expect(service.store.listNodes(first.id).find((node) => node.id === firstPlan.id)?.status)
        .toBe('completed');
      expect(service.store.listNodes(first.id)
        .filter((node) => node.nodeKey.startsWith('codex-critique'))
        .every((node) => node.status === 'ready' && node.busTaskId === null)).toBe(true);
    } finally {
      service.close();
    }
  });

  it('does not mistake configured model echo for an attested runtime handshake', () => {
    const ctxRoot = tempRoot('harness-unattested-');
    enableCompatibilityHosts(ctxRoot);
    const service = new HarnessService({
      instanceId: `harness-unattested-${randomUUID().slice(0, 8)}`,
      ctxRoot,
      frameworkRoot: ctxRoot,
      org: 'atrium',
      compatibilityDispatchRequested: true,
      diskAvailableBytesOverride: HARNESS_MINIMUM_FREE_DISK_BYTES + 1,
      agentRuntimeStatus: (physicalAgent) => {
        const configured = runningCompatibilityHost(physicalAgent);
        return configured ? { ...configured, actualModelVerified: false } : null;
      },
    });
    try {
      const preflight = service.preflight();
      expect(preflight.compatibility_hosts.running_seat_count).toBe(15);
      expect(preflight.compatibility_hosts.attested_seat_count).toBe(0);
      expect(preflight.compatibility_hosts.satisfied).toBe(false);
      expect(preflight.compatibility_bus_projection.effective).toBe(false);
      expect(preflight.compatibility_hosts.unavailable_seats.every((seat) =>
        seat.includes('runtime-handshake-isolation-attestation-incomplete'))).toBe(true);
    } finally {
      service.close();
    }
  });

  it('refuses completion reconciliation without the node\'s exclusive assigned-seat lease', () => {
    const instanceId = `harness-lease-proof-${randomUUID().slice(0, 8)}`;
    const ctxRoot = join(homedir(), '.cortextos', instanceId);
    cleanupPaths.push(ctxRoot);
    enableCompatibilityHosts(ctxRoot);
    const service = new HarnessService({
      instanceId,
      ctxRoot,
      frameworkRoot: ctxRoot,
      org: 'atrium',
      compatibilityDispatchRequested: true,
      diskAvailableBytesOverride: HARNESS_MINIMUM_FREE_DISK_BYTES + 1,
      agentRuntimeStatus: runningCompatibilityHost,
    });
    try {
      const first = submitAligned(service, { title: 'Lease proof first' });
      const second = submitAligned(service, { title: 'Lease proof second' });
      const firstPlan = service.store.listNodes(first.id).find((node) => node.nodeKey === 'fable-plan')!;
      const firstLease = service.store.listLeases({ projectId: first.id, status: 'active' })
        .find((lease) => lease.nodeId === firstPlan.id)!;
      service.store.releaseLease(firstLease.id);

      const competingNode = service.store.createNode({
        id: `${second.id}:seat-holder`,
        projectId: second.id,
        nodeKey: 'seat-holder',
        name: 'Seat holder',
        requiredPool: 'fable',
        assignedSeat: firstPlan.assignedSeat,
      });
      const competingLease = service.store.acquireLease({
        logicalSeat: firstPlan.assignedSeat!,
        projectId: second.id,
        nodeId: competingNode.id,
      });
      const paths = resolvePaths('harness', instanceId, 'atrium');
      completeTask(paths, firstPlan.busTaskId!, 'Must wait for the assigned seat lease.');

      service.tick();
      expect(service.store.listNodes(first.id).find((node) => node.id === firstPlan.id)).toMatchObject({
        status: 'blocked',
        outputSummary: expect.stringContaining('lease-unavailable'),
      });

      service.store.releaseLease(competingLease.id);
      service.tick();
      expect(service.store.listNodes(first.id).find((node) => node.id === firstPlan.id)?.status)
        .toBe('completed');
    } finally {
      service.close();
    }
  });

  it('reconciles normally archived completed tasks and fails a cancelled workflow closed', () => {
    const instanceId = `harness-archive-${randomUUID().slice(0, 8)}`;
    const ctxRoot = join(homedir(), '.cortextos', instanceId);
    cleanupPaths.push(ctxRoot);
    enableCompatibilityHosts(ctxRoot);
    const service = new HarnessService({
      instanceId,
      ctxRoot,
      frameworkRoot: ctxRoot,
      org: 'atrium',
      compatibilityDispatchRequested: true,
      diskAvailableBytesOverride: HARNESS_MINIMUM_FREE_DISK_BYTES + 1,
      agentRuntimeStatus: runningCompatibilityHost,
    });
    try {
      const archivedProject = submitAligned(service, { title: 'Archived completion project' });
      let plan = service.store.listNodes(archivedProject.id).find((node) => node.nodeKey === 'fable-plan')!;
      const paths = resolvePaths('harness', instanceId, 'atrium');
      completeTask(paths, plan.busTaskId!, 'Archived plan output');
      const taskPath = join(paths.taskDir, `${plan.busTaskId}.json`);
      const archivedDir = join(paths.taskDir, 'archive');
      mkdirSync(archivedDir, { recursive: true });
      renameSync(taskPath, join(archivedDir, `${plan.busTaskId}.json`));
      service.tick();
      plan = service.store.listNodes(archivedProject.id).find((node) => node.id === plan.id)!;
      expect(plan.status).toBe('completed');

      const cancelledProject = submitAligned(service, { title: 'Cancelled task project' });
      const cancelledPlan = service.store.listNodes(cancelledProject.id)
        .find((node) => node.nodeKey === 'fable-plan')!;
      updateTask(paths, cancelledPlan.busTaskId!, 'cancelled');
      service.tick();
      expect(service.store.getProject(cancelledProject.id)?.status).toBe('cancelled');
      expect(service.store.listNodes(cancelledProject.id)
        .find((node) => node.id === cancelledPlan.id)?.status).toBe('failed');
    } finally {
      service.close();
    }
  });

  it('rejects Node below 26 before opening or creating the shadow store', () => {
    const ctxRoot = tempRoot();
    expect(() => createService(ctxRoot, { nodeMajorOverride: 25 })).toThrow(/Node 26\+/);
    expect(existsSync(join(ctxRoot, 'harness'))).toBe(false);
  });

  it('enforces a single writer, releases only its owned lock, and permits a clean restart', () => {
    const ctxRoot = tempRoot();
    const first = createService(ctxRoot);
    const lockPath = join(ctxRoot, 'harness', 'writer.lock');
    try {
      expect(existsSync(lockPath)).toBe(true);
      expect(() => createService(ctxRoot)).toThrow(/live writer/i);
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      first.close();
    }
    expect(existsSync(lockPath)).toBe(false);

    const restarted = createService(ctxRoot);
    try {
      expect(restarted.initialize()).toMatchObject({ initialized: true });
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      restarted.close();
    }
    expect(existsSync(lockPath)).toBe(false);
  });

  it('safely reclaims a writer lock owned by a dead PID', () => {
    const ctxRoot = tempRoot();
    const harnessDir = join(ctxRoot, 'harness');
    const lockPath = join(harnessDir, 'writer.lock');
    mkdirSync(harnessDir, { recursive: true });
    writeFileSync(lockPath, JSON.stringify({
      pid: 999_999,
      token: 'dead-owner-token',
      acquired_at_ms: Date.now() - 60_000,
    }));

    const service = createService(ctxRoot);
    try {
      const owner = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid: number; token: string };
      expect(owner.pid).toBe(process.pid);
      expect(owner.token).not.toBe('dead-owner-token');
    } finally {
      service.close();
    }
    expect(existsSync(lockPath)).toBe(false);
  });

  it('creates and resolves human requests through the service contract', () => {
    const service = createService();
    try {
      const project = submitAligned(service, { title: 'Human checkpoint project' });
      const request = service.createHumanRequest({
        projectId: project.id,
        title: 'Choose the data-retention policy',
        description: 'Select the approved retention window.',
        assignedTo: 'operator',
      });
      expect(request.status).toBe('open');
      const resolved = service.resolveHumanRequest({
        requestId: request.id,
        response: 'Use the documented 30-day window.',
      });
      expect(resolved.status).toBe('resolved');
      expect(resolved.response).toBe('Use the documented 30-day window.');
    } finally {
      service.close();
    }
  });

  it('validates harness IPC actions and serves the live service', async () => {
    const instanceId = `harness-ipc-${randomUUID().slice(0, 8)}`;
    const ipcRoot = join(homedir(), '.cortextos', instanceId);
    mkdirSync(ipcRoot, { recursive: true });
    cleanupPaths.push(ipcRoot);
    const service = createService();
    service.initialize();
    const server = new IPCServer({} as AgentManager, instanceId, service);

    try {
      await server.start();
      const client = new IPCClient(instanceId);
      const invalid = await client.send({
        type: 'harness',
        data: { action: 'provider-call' },
        source: 'integration-test',
      });
      expect(invalid).toMatchObject({ success: false, code: 'INVALID_INPUT' });

      const valid = await client.send({
        type: 'harness',
        data: { action: 'status', payload: {} },
        source: 'integration-test',
      });
      expect(valid.success).toBe(true);
      expect(valid.data).toMatchObject({
        mode: 'compatibility-shadow',
        initialized: true,
        control: {
          dispatch_enabled: false,
          egress_enabled: false,
          spend_enabled: false,
          provisioning_enabled: false,
        },
      });
    } finally {
      server.stop();
      service.close();
    }
  });
});
