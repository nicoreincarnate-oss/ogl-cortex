/**
 * Deterministic compatibility-shadow workflow.
 *
 * The workflow is eleven nodes. Align comes first (Kem / Glitch Cat Club delivery
 * lifecycle, steps 1-7: nothing is planned or built before the needs are written
 * down and a human has signed them off), then the critique/refutation loop:
 * plan -> two blind critiques -> revision -> research -> build -> independent
 * review -> correction plan -> correction build/test -> fresh O3 final review.
 * The explicit second Sonnet build prevents O3 from reviewing an unchanged
 * candidate after Opus findings.
 */

import type {
  CreateNodeInput,
  AcquireLeaseInput,
  HumanRequest,
  LeaseListFilter,
  Project,
  ProjectListFilter,
  SeatLease,
  UpdateNodeInput,
  WorkflowNode,
} from './types.js';

export type HarnessPool = 'fable' | 'sonnet' | 'opus';
export const COMPATIBILITY_BLOCK_TIMEOUT_MS = 24 * 60 * 60 * 1_000;

export interface WorkflowStageDefinition {
  ordinal: number;
  key: string;
  label: string;
  stage: string;
  role: string;
  pool: HarnessPool;
  capability: string;
  freshSessionRequired: boolean;
  dependsOn: readonly string[];
  instructions: string;
}

export const SHADOW_WORKFLOW_ID = 'cortex-shadow-align-adversarial-eleven/v3';

/** Human request that gates the plan once Align completes. One per project, deterministic id. */
export const alignSignoffRequestId = (projectId: string): string => `${projectId}:hr:align-signoff`;

export const SHADOW_WORKFLOW: readonly WorkflowStageDefinition[] = [
  {
    ordinal: 0,
    key: 'fable-align',
    label: 'Fable align',
    stage: 'alignment',
    role: 'project-aligner',
    pool: 'fable',
    capability: 'project-planning',
    freshSessionRequired: false,
    dependsOn: [],
    instructions: 'Before any plan or code, write seven alignment files: (1) outcome brief with numbered needs and an acceptance bar per need, no architecture; (2) shared vocabulary for the build; (3) pattern pass: existing or open-source solutions to reuse; (4) design boards for anything visual (throwaway, signed off, never iterated in production); (5) case matrix: every case and state; (6) data model: source of truth, one writer per fact, module map; (7) requirement ledger tying each need to design and code. Then stop: the scheduler opens a human sign-off request on the numbered needs and the plan waits for it.',
  },
  {
    ordinal: 1,
    key: 'fable-plan',
    label: 'Fable plan',
    stage: 'planning',
    role: 'project-planner',
    pool: 'fable',
    capability: 'project-planning',
    freshSessionRequired: false,
    dependsOn: ['fable-align'],
    instructions: 'Author the initial implementation plan from the signed-off alignment files with explicit assumptions, acceptance criteria, risks, and unresolved questions.',
  },
  {
    ordinal: 2,
    key: 'sonnet-critique-a',
    label: 'Sonnet blind critique A',
    stage: 'critique',
    role: 'blind-technical-critic',
    pool: 'sonnet',
    capability: 'feasibility-review',
    freshSessionRequired: true,
    dependsOn: ['fable-plan'],
    instructions: 'Independently challenge the plan. Emit stable critique IDs and do not read the other Sonnet critique.',
  },
  {
    ordinal: 3,
    key: 'sonnet-critique-b',
    label: 'Sonnet blind critique B',
    stage: 'critique',
    role: 'blind-adversarial-critic',
    pool: 'sonnet',
    capability: 'feasibility-review',
    freshSessionRequired: true,
    dependsOn: ['fable-plan'],
    instructions: 'Independently attack hidden assumptions, failure modes, security, and testability. Emit stable critique IDs and remain blind to critique A.',
  },
  {
    ordinal: 4,
    key: 'fable-revision',
    label: 'Fable critique resolution',
    stage: 'revision',
    role: 'project-planner',
    pool: 'fable',
    capability: 'project-planning',
    freshSessionRequired: false,
    dependsOn: ['sonnet-critique-a', 'sonnet-critique-b'],
    instructions: 'Revise the plan and resolve every critique ID explicitly; preserve disagreements that require evidence or human judgment.',
  },
  {
    ordinal: 5,
    key: 'sonnet-research',
    label: 'Sonnet implementation research',
    stage: 'research',
    role: 'implementation-researcher',
    pool: 'sonnet',
    capability: 'research',
    freshSessionRequired: true,
    dependsOn: ['fable-revision'],
    instructions: 'Validate the revised plan against the repository and produce source-backed implementation constraints and a narrow build packet.',
  },
  {
    ordinal: 6,
    key: 'sonnet-build',
    label: 'Sonnet build and test',
    stage: 'build',
    role: 'implementation-builder',
    pool: 'sonnet',
    capability: 'build',
    freshSessionRequired: true,
    dependsOn: ['sonnet-research'],
    instructions: 'Implement the accepted packet, run deterministic tests, and return artifacts and unresolved failures without claiming external release.',
  },
  {
    ordinal: 7,
    key: 'opus-review',
    label: 'Opus independent review',
    stage: 'review',
    role: 'independent-reviewer',
    pool: 'opus',
    capability: 'general-review',
    freshSessionRequired: true,
    dependsOn: ['sonnet-build'],
    instructions: 'Review the built candidate independently against the revised plan and tests. Emit stable finding IDs.',
  },
  {
    ordinal: 8,
    key: 'fable-correction',
    label: 'Fable correction synthesis',
    stage: 'correction',
    role: 'project-planner',
    pool: 'fable',
    capability: 'replanning',
    freshSessionRequired: false,
    dependsOn: ['opus-review'],
    instructions: 'Resolve every Opus finding ID, define required corrections, and explicitly escalate anything that cannot be closed safely.',
  },
  {
    ordinal: 9,
    key: 'sonnet-correction',
    label: 'Sonnet correction build and test',
    stage: 'correction-build',
    role: 'implementation-builder',
    pool: 'sonnet',
    capability: 'build',
    freshSessionRequired: true,
    dependsOn: ['fable-correction'],
    instructions: 'Apply the accepted Fable correction packet to the candidate, rerun deterministic tests, and return the corrected artifacts plus evidence for every Opus finding ID.',
  },
  {
    ordinal: 10,
    key: 'o3-final-review',
    label: 'O3 fresh final review',
    stage: 'final-review',
    role: 'final-arbiter',
    pool: 'opus',
    capability: 'final-review-only',
    freshSessionRequired: true,
    dependsOn: ['sonnet-correction'],
    instructions: 'In a fresh candidate-scoped session, issue the final shadow verdict. This never authorizes merge, spend, deployment, or external effect.',
  },
] as const;

interface SchedulerStorePort {
  listProjects(filter?: ProjectListFilter): Project[];
  admitProject(projectId: string): Project;
  cancelProject(projectId: string, reason?: string): Project;
  createNode(input: CreateNodeInput): WorkflowNode;
  listNodes(projectId: string): WorkflowNode[];
  updateNode(nodeId: string, patch: UpdateNodeInput): WorkflowNode;
  listHumanRequests(projectId?: string): HumanRequest[];
  createHumanRequest(input: { id?: string; projectId: string; title: string; description?: string; assignedTo?: string | null }): HumanRequest;
  completeProject(projectId: string): Project;
  acquireLease(input: AcquireLeaseInput): SeatLease;
  renewLease(leaseId: string, ttlMs?: number): SeatLease;
  releaseLease(leaseId: string): SeatLease;
  listLeases(filter?: LeaseListFilter): SeatLease[];
}

export interface CompatibilityWorkProjection {
  project: Project;
  node: WorkflowNode;
  stage: WorkflowStageDefinition;
}

export type CompatibilityWorkProjector = (
  work: CompatibilityWorkProjection,
) => { taskId: string; messageId?: string };

export type CompatibilityTaskStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'blocked'
  | 'cancelled'
  | 'missing';

export interface CompatibilityTaskObservation {
  status: CompatibilityTaskStatus;
  outputSummary?: string;
}

export type CompatibilityWorkReader = (
  work: CompatibilityWorkProjection,
) => CompatibilityTaskObservation;

export interface SchedulerTickResult {
  workflow_id: typeof SHADOW_WORKFLOW_ID;
  admitted_project_ids: string[];
  materialized_project_ids: string[];
  ready_node_ids: string[];
  compatibility_projected_node_ids: string[];
  compatibility_reconciled_node_ids: string[];
  acquired_lease_ids: string[];
  renewed_lease_ids: string[];
  released_lease_ids: string[];
  completed_project_ids: string[];
  failed_project_ids: string[];
  compatibility_dispatch_enabled: boolean;
}

function assignedSeat(project: Project, stage: WorkflowStageDefinition): string {
  const slot = project.slotNo ?? 1;
  if (stage.key === 'o3-final-review') return 'o3';
  if (stage.pool === 'opus') {
    let hash = 0;
    for (const char of project.id) hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
    return hash % 2 === 0 ? 'o1' : 'o2';
  }
  if (stage.pool === 'fable') return `f${Math.max(1, Math.min(4, slot))}`;

  // Each project has a stable pair from the eight-seat Sonnet pool. Parallel
  // blind critiques are deliberately split across the pair.
  const pairBase = ((Math.max(1, Math.min(4, slot)) - 1) * 2) + 1;
  return stage.key === 'sonnet-critique-b' || stage.key === 'sonnet-build'
    || stage.key === 'sonnet-correction'
    ? `c${pairBase + 1}`
    : `c${pairBase}`;
}

export class HarnessScheduler {
  private readonly store: SchedulerStorePort;
  private readonly compatibilityDispatchEnabled: boolean;
  private readonly projectCompatibilityWork?: CompatibilityWorkProjector;
  private readonly readCompatibilityWork?: CompatibilityWorkReader;

  constructor(
    store: unknown,
    options: {
      compatibilityDispatchEnabled?: boolean;
      projectCompatibilityWork?: CompatibilityWorkProjector;
      readCompatibilityWork?: CompatibilityWorkReader;
    } = {},
  ) {
    this.store = store as SchedulerStorePort;
    this.compatibilityDispatchEnabled = options.compatibilityDispatchEnabled === true;
    this.projectCompatibilityWork = options.projectCompatibilityWork;
    this.readCompatibilityWork = options.readCompatibilityWork;
  }

  tick(): SchedulerTickResult {
    const result: SchedulerTickResult = {
      workflow_id: SHADOW_WORKFLOW_ID,
      admitted_project_ids: [],
      materialized_project_ids: [],
      ready_node_ids: [],
      compatibility_projected_node_ids: [],
      compatibility_reconciled_node_ids: [],
      acquired_lease_ids: [],
      renewed_lease_ids: [],
      released_lease_ids: [],
      completed_project_ids: [],
      failed_project_ids: [],
      compatibility_dispatch_enabled: this.compatibilityDispatchEnabled,
    };

    // The store owns the four-slot invariant. Sorting here only makes which
    // queued project gets the next available slot deterministic.
    const queued = this.store.listProjects({ status: 'queued' })
      .sort((a, b) => b.priority - a.priority
        || a.createdAtMs - b.createdAtMs
        || a.id.localeCompare(b.id));

    for (const project of queued) {
      try {
        this.store.admitProject(project.id);
        result.admitted_project_ids.push(project.id);
      } catch (error) {
        // Slot exhaustion is expected backpressure. Any queued projects remain
        // durable and will be retried on a later deterministic tick.
        if (/slot|capacity|four|admit/i.test(String(error))) break;
        throw error;
      }
    }

    const activeProjects = this.store.listProjects({ status: 'admitted' })
      .sort((a, b) => a.id.localeCompare(b.id));

    // Bound work owns first claim on seats. Reserve/renew it across every
    // project before any project can project a new task, preventing an expired
    // lease in a later-sorted project from being stolen by earlier new work.
    for (const project of activeProjects) {
      for (const node of this.store.listNodes(project.id)) {
        if (!node.busTaskId || ['blocked', 'completed', 'failed', 'cancelled'].includes(node.status)) continue;
        this.acquireNodeLease(project, node, result);
      }
    }

    for (const project of activeProjects) {
      const projectId = project.id;
      let nodes = this.store.listNodes(projectId);
      const byKey = new Map(nodes.map((node) => [node.nodeKey, node]));
      let materialized = false;

      for (const stage of SHADOW_WORKFLOW) {
        if (byKey.has(stage.key)) continue;
        // Projects created before Align existed already have a plan node; they never get an Align stage.
        if (stage.key === 'fable-align' && byKey.has('fable-plan')) continue;
        const dependencyNodeIds = stage.dependsOn
          .map((dependencyKey) => byKey.get(dependencyKey))
          .filter((node): node is WorkflowNode => Boolean(node))
          .map((node) => node.id);
        const requiredDependencies = stage.dependsOn.filter((key) => !(key === 'fable-align' && !byKey.has('fable-align')));
        if (dependencyNodeIds.length !== requiredDependencies.length) {
          throw new Error(`Cannot materialize ${stage.key}: dependency closure is incomplete`);
        }

        const created = this.store.createNode({
          id: `${projectId}:node:${String(stage.ordinal).padStart(2, '0')}`,
          projectId,
          nodeKey: stage.key,
          name: stage.label,
          kind: stage.stage,
          requiredPool: stage.pool,
          assignedSeat: assignedSeat(project, stage),
          dependsOn: dependencyNodeIds,
          inputSummary: JSON.stringify({
            workflowId: SHADOW_WORKFLOW_ID,
            ordinal: stage.ordinal,
            stageKey: stage.key,
            role: stage.role,
            capability: stage.capability,
            freshSessionRequired: stage.freshSessionRequired,
            instructions: stage.instructions,
          }),
        });
        byKey.set(stage.key, created);
        materialized = true;
      }

      if (materialized) {
        result.materialized_project_ids.push(projectId);
      }

      nodes = this.store.listNodes(projectId);
      const preexistingFailure = nodes.find((node) => node.status === 'failed' || node.status === 'cancelled');
      if (preexistingFailure) {
        for (const node of nodes) this.releaseNodeLeases(node, result);
        this.store.cancelProject(
          projectId,
          `Workflow terminated at ${preexistingFailure.nodeKey}: ${preexistingFailure.outputSummary ?? preexistingFailure.status}`,
        );
        result.failed_project_ids.push(projectId);
        continue;
      }

      // Align gate: when Align completes, open one deterministic sign-off request. The project-wide human
      // gate below then blocks every ready node until a human resolves it.
      this.ensureAlignSignoff(project, nodes);
      const alignSignoff = this.store.listHumanRequests(projectId)
        .find((request) => request.id === alignSignoffRequestId(projectId));
      if (alignSignoff?.status === 'cancelled') {
        for (const node of nodes) this.releaseNodeLeases(node, result);
        this.store.cancelProject(projectId, 'Align sign-off was cancelled: the numbered needs were not accepted.');
        result.failed_project_ids.push(projectId);
        continue;
      }

      const openHumanRequests = this.store.listHumanRequests(projectId)
        .filter((request) => request.status === 'open');
      if (openHumanRequests.length > 0) {
        nodes = this.store.listNodes(projectId);
        const requestIds = openHumanRequests.map((request) => request.id).join(', ');
        for (const node of nodes) {
          if (node.busTaskId && !['completed', 'failed', 'cancelled'].includes(node.status)) {
            this.acquireNodeLease(project, node, result);
          }
          if (!['ready', 'dispatched', 'running'].includes(node.status)) continue;
          this.store.updateNode(node.id, {
            status: 'blocked',
            outputSummary: `[human-gate] Awaiting human request(s): ${requestIds}`,
          });
        }
        continue;
      }

      // Reconcile already-bound work even when new dispatch has been locked
      // since startup. This lets a fail-closed readiness change stop new work
      // without orphaning durable tasks or their leases.
      if (this.readCompatibilityWork) {
        nodes = this.store.listNodes(projectId);
        const stageByKey = new Map(SHADOW_WORKFLOW.map((stage) => [stage.key, stage]));
        for (const node of nodes) {
          if (!node.busTaskId || ['completed', 'failed', 'cancelled'].includes(node.status)) continue;
          const stage = stageByKey.get(node.nodeKey);
          if (!stage) continue;
          const observation = this.readCompatibilityWork({ project, node, stage });
          if (observation.status === 'blocked' || observation.status === 'missing'
            || observation.status === 'cancelled') {
            const reconciled = this.reconcileCompatibilityNode(node, observation);
            if (reconciled.revision !== node.revision) {
              result.compatibility_reconciled_node_ids.push(node.id);
            }
            this.releaseNodeLeases(reconciled, result);
            continue;
          }
          const lease = this.acquireNodeLease(project, node, result);
          if (!lease) {
            const timedOut = node.status === 'blocked'
              && node.outputSummary?.startsWith('[lease-unavailable]')
              && Date.now() - node.updatedAtMs >= COMPATIBILITY_BLOCK_TIMEOUT_MS;
            const waitingSummary = '[lease-unavailable] Bound compatibility work is paused until its exclusive seat can be reacquired.';
            if (!timedOut && node.status === 'blocked' && node.outputSummary === waitingSummary) {
              continue;
            }
            const next = this.store.updateNode(node.id, {
              status: timedOut ? 'failed' : 'blocked',
              outputSummary: timedOut
                ? '[lease-timeout] Bound compatibility work could not reacquire its exclusive seat within 24 hours.'
                : waitingSummary,
            });
            if (next.revision !== node.revision) result.compatibility_reconciled_node_ids.push(node.id);
            continue;
          }
          const reconciled = this.reconcileCompatibilityNode(node, observation);
          if (reconciled.revision !== node.revision) {
            result.compatibility_reconciled_node_ids.push(node.id);
          }
          if (['completed', 'failed', 'cancelled'].includes(reconciled.status)) {
            this.releaseNodeLeases(reconciled, result);
          }
        }
      }

      // Align may have completed in the reconcile pass above (dispatch mode): open its sign-off now, not a tick later.
      this.ensureAlignSignoff(project, this.store.listNodes(projectId));

      nodes = this.store.listNodes(projectId);
      const failedNode = nodes.find((node) => node.status === 'failed' || node.status === 'cancelled');
      if (failedNode) {
        for (const node of nodes) this.releaseNodeLeases(node, result);
        this.store.cancelProject(
          projectId,
          `Workflow terminated at ${failedNode.nodeKey}: ${failedNode.outputSummary ?? failedNode.status}`,
        );
        result.failed_project_ids.push(projectId);
        continue;
      }

      // A project-wide human gate can block an unprojected ready node. Once
      // every request is resolved, return only those explicitly tagged nodes
      // to ready; missing-task and other operational blocks remain closed.
      for (const node of nodes) {
        if (node.status !== 'blocked' || node.busTaskId
          || !node.outputSummary?.startsWith('[human-gate]')) continue;
        this.store.updateNode(node.id, { status: 'ready', outputSummary: null });
      }

      nodes = this.store.listNodes(projectId);
      const refreshedByKey = new Map(nodes.map((node) => [node.nodeKey, node]));

      for (const stage of SHADOW_WORKFLOW) {
        const node = refreshedByKey.get(stage.key);
        if (!node || !['pending', 'ready'].includes(node.status)) continue;
        const dependenciesAccepted = stage.dependsOn.every((dependencyKey) => {
          const dependency = refreshedByKey.get(dependencyKey);
          if (dependencyKey === 'fable-align' && !dependency) return true; // project predates Align
          return dependency?.status === 'completed';
        });
        if (!dependenciesAccepted) continue;
        if (stage.key === 'fable-plan' && refreshedByKey.has('fable-align')) {
          const signoff = this.store.listHumanRequests(projectId)
            .find((request) => request.id === alignSignoffRequestId(projectId));
          if (signoff?.status !== 'resolved') continue; // cancelled or missing never unlocks the plan
        }

        if (node.status !== 'ready') {
          this.store.updateNode(node.id, { status: 'ready' });
        }
        result.ready_node_ids.push(node.id);

        if (!this.compatibilityDispatchEnabled || !this.projectCompatibilityWork) continue;
        if (node.busTaskId) continue;
        const lease = this.acquireNodeLease(project, node, result);
        if (!lease) continue;
        try {
          const projected = this.projectCompatibilityWork({ project, node, stage });
          this.store.updateNode(node.id, {
            status: 'dispatched',
            busTaskId: projected.taskId,
          });
          result.compatibility_projected_node_ids.push(node.id);
        } catch (error) {
          this.releaseNodeLeases(node, result);
          throw error;
        }
      }

      const finalNode = this.store.listNodes(projectId)
        .find((node) => node.nodeKey === 'o3-final-review');
      const hasOpenHumanRequest = this.store.listHumanRequests(projectId)
        .some((request) => request.status === 'open');
      if (finalNode?.status === 'completed' && !hasOpenHumanRequest) {
        this.store.completeProject(projectId);
        result.completed_project_ids.push(projectId);
      }
    }

    return result;
  }

  private ensureAlignSignoff(project: Project, nodes: WorkflowNode[]): void {
    const alignNode = nodes.find((node) => node.nodeKey === 'fable-align');
    if (alignNode?.status !== 'completed') return;
    if (this.store.listHumanRequests(project.id).some((request) => request.id === alignSignoffRequestId(project.id))) return;
    this.store.createHumanRequest({
      id: alignSignoffRequestId(project.id),
      projectId: project.id,
      title: 'Sign off the numbered needs (Align)',
      description: `Align finished for "${project.title}". Read the outcome brief and its numbered needs; resolve this request to let the plan start, or cancel it to stop the project here.`,
      assignedTo: 'operator',
    });
  }

  private acquireNodeLease(
    project: Project,
    node: WorkflowNode,
    result: SchedulerTickResult,
  ): SeatLease | null {
    if (!node.assignedSeat) return null;
    const existingForNode = this.store.listLeases({ projectId: project.id, status: 'active' })
      .find((lease) => lease.nodeId === node.id);
    if (existingForNode) {
      if (existingForNode.expiresAtMs - Date.now() < 12 * 60 * 60 * 1_000) {
        const renewed = this.store.renewLease(existingForNode.id, 24 * 60 * 60 * 1_000);
        if (!result.renewed_lease_ids.includes(renewed.id)) result.renewed_lease_ids.push(renewed.id);
        return renewed;
      }
      return existingForNode;
    }
    if (this.store.listLeases({ logicalSeat: node.assignedSeat, status: 'active' }).length > 0) {
      return null;
    }
    try {
      const lease = this.store.acquireLease({
        logicalSeat: node.assignedSeat,
        projectId: project.id,
        nodeId: node.id,
        ttlMs: 24 * 60 * 60 * 1_000,
      });
      result.acquired_lease_ids.push(lease.id);
      return lease;
    } catch (error) {
      if (/active lease|already has/i.test(String(error))) return null;
      throw error;
    }
  }

  private releaseNodeLeases(node: WorkflowNode, result: SchedulerTickResult): void {
    const leases = this.store.listLeases({ projectId: node.projectId, status: 'active' })
      .filter((lease) => lease.nodeId === node.id);
    for (const lease of leases) {
      this.store.releaseLease(lease.id);
      if (!result.released_lease_ids.includes(lease.id)) result.released_lease_ids.push(lease.id);
    }
  }

  private reconcileCompatibilityNode(
    original: WorkflowNode,
    observation: CompatibilityTaskObservation,
  ): WorkflowNode {
    let node = original;
    const update = (status: UpdateNodeInput['status'], outputSummary?: string): void => {
      if (node.status === status
        && (outputSummary === undefined || outputSummary === node.outputSummary)) return;
      node = this.store.updateNode(node.id, {
        status,
        ...(outputSummary === undefined ? {} : { outputSummary }),
      });
    };

    const unblockFor = (target: CompatibilityTaskStatus): void => {
      if (node.status === 'blocked' && ['pending', 'in_progress', 'completed'].includes(target)) {
        update('ready');
      }
      if (node.status === 'pending' && ['pending', 'in_progress', 'completed'].includes(target)) {
        update('ready');
      }
    };

    if ((observation.status === 'blocked' || observation.status === 'missing')
      && node.status === 'blocked'
      && Date.now() - node.updatedAtMs >= COMPATIBILITY_BLOCK_TIMEOUT_MS) {
      update(
        'failed',
        `[compatibility-timeout] Task ${node.busTaskId ?? '(unbound)'} remained ${observation.status} for 24 hours.`,
      );
      return node;
    }

    unblockFor(observation.status);
    switch (observation.status) {
      case 'pending':
        if (node.status === 'ready') update('dispatched', observation.outputSummary);
        break;
      case 'in_progress':
        if (node.status === 'ready' || node.status === 'dispatched') {
          update('running', observation.outputSummary);
        }
        break;
      case 'completed':
        if (node.status === 'ready') update('running');
        if (node.status === 'dispatched' || node.status === 'running') {
          update('completed', observation.outputSummary ?? 'Compatibility task completed');
        }
        break;
      case 'blocked':
      case 'missing':
        if (['ready', 'dispatched', 'running', 'blocked'].includes(node.status)) {
          update('blocked', observation.outputSummary
            ?? (observation.status === 'missing'
              ? `Compatibility task ${node.busTaskId ?? ''} is missing; operator action is required.`
              : 'Compatibility task is blocked.'));
        }
        break;
      case 'cancelled':
        update('failed', observation.outputSummary ?? 'Compatibility task was cancelled.');
        break;
    }
    return node;
  }
}
