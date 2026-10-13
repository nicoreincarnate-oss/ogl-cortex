/**
 * Types for the local CortexOS compatibility harness.
 *
 * This store is deliberately NOT the v2.1 authoritative control plane.  Its
 * DTOs carry that fact so callers cannot honestly present shadow state as a
 * production authorization or dispatch decision.
 */

export const HARNESS_MODE = 'compatibility-shadow' as const;
export type HarnessMode = typeof HARNESS_MODE;

export type ProjectStatus =
  | 'queued'
  | 'admitted'
  | 'paused'
  | 'completed'
  | 'cancelled';

export type WorkflowNodeStatus =
  | 'pending'
  | 'ready'
  | 'dispatched'
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type HumanRequestStatus = 'open' | 'resolved' | 'cancelled';
export type SeatLeaseStatus = 'active' | 'released' | 'expired';
export type SeatPool = 'fable' | 'sonnet' | 'opus';

export interface HarnessControlState {
  mode: HarnessMode;
  productionAuthoritative: false;
  dispatchEnabled: false;
  provisioningEnabled: false;
  providerCallsEnabled: false;
  spendingEnabled: false;
  canonicalGitMutationEnabled: false;
  externalEgressEnabled: false;
  schemaVersion: 1;
  initializedAtMs: number;
}

export interface ProjectSlot {
  slotNo: number;
  ownerLogicalSeat: string;
  generation: number;
  currentProjectId: string | null;
  updatedAtMs: number;
}

export interface Project {
  id: string;
  org: string;
  title: string;
  description: string;
  priority: number;
  status: ProjectStatus;
  slotNo: number | null;
  slotGeneration: number | null;
  revision: number;
  createdAtMs: number;
  updatedAtMs: number;
  completedAtMs: number | null;
  cancellationReason: string | null;
}

export interface SubmitProjectInput {
  id?: string;
  org: string;
  title: string;
  description?: string;
  priority?: number;
}

export interface ProjectListFilter {
  status?: ProjectStatus | ProjectStatus[];
}

export interface RosterSeat {
  logicalSeat: string;
  pool: SeatPool;
  role: string;
  desiredRuntime: 'claude-code';
  desiredModel: 'fable-5' | 'sonnet-5.5' | 'opus-4.8';
  desiredProfile: 'ultra';
  physicalAgent: string;
  enabled: false;
}

export interface WorkflowNode {
  id: string;
  projectId: string;
  nodeKey: string;
  name: string;
  kind: string;
  requiredPool: SeatPool | null;
  assignedSeat: string | null;
  status: WorkflowNodeStatus;
  dependsOn: string[];
  inputSummary: string;
  outputSummary: string | null;
  busTaskId: string | null;
  revision: number;
  createdAtMs: number;
  updatedAtMs: number;
  completedAtMs: number | null;
}

export interface CreateNodeInput {
  id?: string;
  projectId: string;
  nodeKey?: string;
  name: string;
  kind?: string;
  requiredPool?: SeatPool | null;
  assignedSeat?: string | null;
  dependsOn?: string[];
  inputSummary?: string;
}

export interface UpdateNodeInput {
  status: WorkflowNodeStatus;
  assignedSeat?: string | null;
  outputSummary?: string | null;
  busTaskId?: string | null;
}

export interface HumanRequest {
  id: string;
  projectId: string;
  title: string;
  description: string;
  assignedTo: string | null;
  status: HumanRequestStatus;
  response: string | null;
  dueAtMs: number | null;
  revision: number;
  createdAtMs: number;
  updatedAtMs: number;
  resolvedAtMs: number | null;
}

export interface CreateHumanRequestInput {
  id?: string;
  projectId: string;
  title: string;
  description?: string;
  assignedTo?: string | null;
  dueAtMs?: number | null;
}

export interface ResolveHumanRequestInput {
  response?: string;
  status?: Extract<HumanRequestStatus, 'resolved' | 'cancelled'>;
}

export interface SeatLease {
  id: string;
  logicalSeat: string;
  projectId: string;
  nodeId: string | null;
  status: SeatLeaseStatus;
  acquiredAtMs: number;
  expiresAtMs: number;
  releasedAtMs: number | null;
  revision: number;
}

export interface AcquireLeaseInput {
  id?: string;
  logicalSeat: string;
  projectId: string;
  nodeId?: string | null;
  ttlMs?: number;
}

export interface LeaseListFilter {
  projectId?: string;
  logicalSeat?: string;
  status?: SeatLeaseStatus;
}

export interface HarnessEvent {
  seq: number;
  id: string;
  eventType: string;
  entityType: string;
  entityId: string;
  projectId: string | null;
  message: string;
  metadata: Record<string, unknown>;
  createdAtMs: number;
}

export interface HarnessStatus {
  mode: HarnessMode;
  productionAuthoritative: false;
  databasePath: string;
  control: HarnessControlState;
  slots: ProjectSlot[];
  projectCounts: Record<ProjectStatus, number>;
  activeProjectCount: number;
  queuedProjectCount: number;
  rosterSeatCount: number;
}

export interface ProjectProjection {
  id: string;
  org: string;
  title: string;
  priority: number;
  status: ProjectStatus;
  slotNo: number | null;
  slotGeneration: number | null;
  revision: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface NodeProjection {
  id: string;
  projectId: string;
  nodeKey: string;
  name: string;
  kind: string;
  requiredPool: SeatPool | null;
  assignedSeat: string | null;
  status: WorkflowNodeStatus;
  busTaskId: string | null;
  dependsOn: string[];
  revision: number;
  updatedAtMs: number;
}

export interface HumanRequestProjection {
  id: string;
  projectId: string;
  title: string;
  assignedTo: string | null;
  status: HumanRequestStatus;
  dueAtMs: number | null;
  revision: number;
  updatedAtMs: number;
}

export interface LeaseProjection {
  id: string;
  logicalSeat: string;
  projectId: string;
  nodeId: string | null;
  status: SeatLeaseStatus;
  expiresAtMs: number;
}

export interface HarnessProjectionSnapshot {
  mode: HarnessMode;
  productionAuthoritative: false;
  generatedAtMs: number;
  control: HarnessControlState;
  slots: ProjectSlot[];
  projects: ProjectProjection[];
  roster: RosterSeat[];
  nodes: NodeProjection[];
  humanRequests: HumanRequestProjection[];
  leases: LeaseProjection[];
  recentEvents: Array<Omit<HarnessEvent, 'metadata'>>;
}
