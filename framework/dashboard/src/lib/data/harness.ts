import fs from 'fs';
import path from 'path';
import { CTX_ROOT } from '@/lib/config';

export const HARNESS_PROJECTION_SCHEMA = 'cortex-harness-shadow-projection/v1';
export const HARNESS_LEGACY_PROJECTION_SCHEMA = 'cortex-harness-projection-v1';
export const HARNESS_PROJECTION_MAX_BYTES = 2 * 1024 * 1024;
export const HARNESS_PROJECTION_MAX_AGE_MS = 30_000;
export const HARNESS_PROJECTION_MAX_FUTURE_SKEW_MS = 5_000;
const MAX_JAVASCRIPT_TIMESTAMP_MS = 8_640_000_000_000_000;

export type HarnessMode =
  | 'stopped'
  | 'shadow'
  | 'active'
  | 'draining'
  | 'blocked'
  | 'unknown';

export type HarnessAdmissionMode =
  | 'open'
  | 'paused'
  | 'draining'
  | 'closed'
  | 'unknown';

export type HarnessProjectStatus =
  | 'queued'
  | 'admitted'
  | 'active'
  | 'blocked'
  | 'paused'
  | 'parked'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export interface HarnessProjectCounts {
  pending: number;
  ready: number;
  running: number;
  blocked: number;
  completed: number;
  failed: number;
  total: number;
}

export interface HarnessBudgetProjection {
  spentMicroUsd: number;
  reservedMicroUsd: number;
  hardCapMicroUsd: number | null;
  currency: 'USD';
}

export interface HarnessProjectProjection {
  id: string;
  name: string;
  org: string | null;
  status: HarnessProjectStatus;
  slot: number | null;
  generation: number | null;
  phase: string | null;
  currentNode: string | null;
  progress: number | null;
  plannerSeat: string | null;
  updatedAtMs: number | null;
  queuedAtMs: number | null;
  admittedAtMs: number | null;
  blockedReason: string | null;
  counts: HarnessProjectCounts;
  budget: HarnessBudgetProjection | null;
  humanRequestsPending: number;
  approvalsPending: number;
}

export interface HarnessSeatSummary {
  total: number;
  available: number;
  leased: number;
  running: number;
  quarantined: number;
}

export type HarnessSeatPool = 'fable' | 'codex' | 'opus' | 'unknown';
export type HarnessSeatState = 'disabled' | 'available' | 'leased' | 'running';

export interface HarnessSeatProjection {
  logicalSeat: string;
  pool: HarnessSeatPool;
  role: string | null;
  physicalAgent: string | null;
  enabled: boolean;
  state: HarnessSeatState;
  projectId: string | null;
  nodeId: string | null;
  leaseExpiresAtMs: number | null;
}

export type HarnessHumanRequestStatus =
  | 'open'
  | 'resolved'
  | 'cancelled'
  | 'unknown';

export interface HarnessHumanRequestProjection {
  id: string;
  projectId: string;
  title: string;
  assignedTo: string | null;
  status: HarnessHumanRequestStatus;
  dueAtMs: number | null;
  updatedAtMs: number | null;
}

export interface HarnessProjectionSnapshot {
  available: boolean;
  state: 'ready' | 'missing' | 'invalid' | 'stale';
  schemaVersion: string | null;
  generatedAtMs: number | null;
  sequence: number | null;
  mode: HarnessMode;
  dispatchEnabled: boolean;
  admissionMode: HarnessAdmissionMode;
  killSwitch: boolean;
  preflightReady: boolean | null;
  preflightBlockers: number;
  preflightScope: 'compatibility-bus-projection' | 'unknown' | null;
  shadowBaseUsable: boolean | null;
  compatibilityProjectionRequested: boolean | null;
  compatibilityProjectionEffective: boolean | null;
  maxLiveProjects: number;
  liveProjects: number;
  queuedProjects: number;
  seatSummary: HarnessSeatSummary;
  seats: HarnessSeatProjection[];
  humanRequests: HarnessHumanRequestProjection[];
  projects: HarnessProjectProjection[];
}

type UnknownRecord = Record<string, unknown>;

interface ProjectCandidate {
  value: unknown;
  status?: HarnessProjectStatus;
  slot?: number;
}

const EMPTY_SEATS: HarnessSeatSummary = {
  total: 0,
  available: 0,
  leased: 0,
  running: 0,
  quarantined: 0,
};

export function getHarnessProjectionPath(): string {
  return path.join(CTX_ROOT, 'harness', 'projection.json');
}

function emptySnapshot(
  state: HarnessProjectionSnapshot['state'],
): HarnessProjectionSnapshot {
  return {
    available: false,
    state,
    schemaVersion: null,
    generatedAtMs: null,
    sequence: null,
    mode: 'unknown',
    dispatchEnabled: false,
    admissionMode: 'unknown',
    killSwitch: false,
    preflightReady: null,
    preflightBlockers: 0,
    preflightScope: null,
    shadowBaseUsable: null,
    compatibilityProjectionRequested: null,
    compatibilityProjectionEffective: null,
    maxLiveProjects: 4,
    liveProjects: 0,
    queuedProjects: 0,
    seatSummary: { ...EMPTY_SEATS },
    seats: [],
    humanRequests: [],
    projects: [],
  };
}

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function safeString(value: unknown, maxLength = 160): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function safeInteger(
  value: unknown,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number | null {
  const candidate =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^-?\d+$/.test(value.trim())
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(candidate)) return null;
  return Math.min(maximum, Math.max(minimum, candidate));
}

function strictInteger(
  value: unknown,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number | null {
  const candidate =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^-?\d+$/.test(value.trim())
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(candidate)
    && candidate >= minimum
    && candidate <= maximum
    ? candidate
    : null;
}

function safeNumber(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  const candidate =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(candidate)) return null;
  return Math.min(maximum, Math.max(minimum, candidate));
}

function safeBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return fallback;
}

function optionalBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return null;
}

function safeTimestamp(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value)
      && value >= 0
      && value <= MAX_JAVASCRIPT_TIMESTAMP_MS
      ? value
      : null;
  }
  if (typeof value !== 'string') return null;
  if (/^-?\d+$/.test(value.trim())) {
    const integer = Number(value);
    return Number.isSafeInteger(integer)
      && integer >= 0
      && integer <= MAX_JAVASCRIPT_TIMESTAMP_MS
      ? integer
      : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    && parsed >= 0
    && parsed <= MAX_JAVASCRIPT_TIMESTAMP_MS
    ? parsed
    : null;
}

function normalizeMode(value: unknown): HarnessMode {
  const mode = safeString(value, 24)?.toLowerCase();
  if (mode === 'compatibility-shadow') return 'shadow';
  if (
    mode === 'stopped' ||
    mode === 'shadow' ||
    mode === 'active' ||
    mode === 'draining' ||
    mode === 'blocked'
  ) {
    return mode;
  }
  return 'unknown';
}

function normalizeAdmissionMode(value: unknown): HarnessAdmissionMode {
  const mode = safeString(value, 24)?.toLowerCase();
  if (
    mode === 'open' ||
    mode === 'paused' ||
    mode === 'draining' ||
    mode === 'closed'
  ) {
    return mode;
  }
  return 'unknown';
}

function normalizeProjectStatus(
  value: unknown,
  fallback: HarnessProjectStatus = 'unknown',
): HarnessProjectStatus {
  const status = safeString(value, 32)?.toLowerCase().replace(/[-\s]+/g, '_');
  if (status === 'done' || status === 'complete') return 'completed';
  if (status === 'running' || status === 'in_progress') return 'active';
  if (
    status === 'queued' ||
    status === 'admitted' ||
    status === 'active' ||
    status === 'blocked' ||
    status === 'paused' ||
    status === 'parked' ||
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled'
  ) {
    return status;
  }
  return fallback;
}

function readCount(record: UnknownRecord | null, ...keys: string[]): number {
  if (!record) return 0;
  for (const key of keys) {
    const value = safeInteger(record[key], 0, 1_000_000);
    if (value !== null) return value;
  }
  return 0;
}

function normalizeCounts(project: UnknownRecord): HarnessProjectCounts {
  const counts =
    asRecord(project.counts) ??
    asRecord(project.node_counts) ??
    asRecord(project.nodeCounts) ??
    asRecord(project.summary);
  const pending = readCount(counts, 'pending');
  const ready = readCount(counts, 'ready');
  const running = readCount(counts, 'running', 'active', 'in_progress');
  const blocked = readCount(counts, 'blocked');
  const completed = readCount(counts, 'completed', 'done', 'succeeded');
  const failed = readCount(counts, 'failed', 'error');
  const computedTotal = pending + ready + running + blocked + completed + failed;
  const total = Math.max(readCount(counts, 'total'), computedTotal);
  return { pending, ready, running, blocked, completed, failed, total };
}

function normalizeBudget(project: UnknownRecord): HarnessBudgetProjection | null {
  const budget = asRecord(project.budget) ?? asRecord(project.budget_summary);
  if (!budget) return null;
  const spentMicroUsd =
    safeInteger(firstDefined(budget.spentMicroUsd, budget.spent_micro_usd), 0) ?? 0;
  const reservedMicroUsd =
    safeInteger(
      firstDefined(budget.reservedMicroUsd, budget.reserved_micro_usd),
      0,
    ) ?? 0;
  const hardCapMicroUsd = safeInteger(
    firstDefined(budget.hardCapMicroUsd, budget.hard_cap_micro_usd),
    0,
  );
  return {
    spentMicroUsd,
    reservedMicroUsd,
    hardCapMicroUsd,
    currency: 'USD',
  };
}

function normalizeSlot(value: unknown): number | null {
  if (typeof value === 'string') {
    const match = value.match(/^(?:slot[-_ ]?)?(\d+)$/i);
    if (match) value = match[1];
  }
  return safeInteger(value, 1, 4);
}

function normalizeProject(
  candidate: ProjectCandidate,
): HarnessProjectProjection | null {
  const project = asRecord(candidate.value);
  if (!project) return null;
  const id = safeString(
    firstDefined(project.id, project.projectId, project.project_id),
    128,
  );
  if (!id) return null;

  const status = normalizeProjectStatus(project.status, candidate.status);
  const slot =
    normalizeSlot(
      firstDefined(
        project.slot,
        project.slotNo,
        project.slot_no,
        project.projectSlot,
        project.project_slot,
      ),
    ) ?? candidate.slot ?? null;

  return {
    id,
    name:
      safeString(
        firstDefined(project.name, project.title, project.project_name),
        160,
      ) ?? id,
    org: safeString(firstDefined(project.org, project.orgId, project.org_id), 80),
    status,
    slot,
    generation: safeInteger(
      firstDefined(
        project.generation,
        project.generation_id,
        project.slotGeneration,
        project.slot_generation,
      ),
      0,
      1_000_000,
    ),
    phase: safeString(firstDefined(project.phase, project.current_phase), 80),
    currentNode: safeString(
      firstDefined(project.currentNode, project.current_node, project.active_node),
      160,
    ),
    progress: safeNumber(
      firstDefined(project.progress, project.progressPercent, project.progress_percent),
      0,
      100,
    ),
    plannerSeat: safeString(
      firstDefined(project.plannerSeat, project.planner_seat),
      80,
    ),
    updatedAtMs: safeTimestamp(
      firstDefined(project.updatedAtMs, project.updated_at_ms, project.updated_at),
    ),
    queuedAtMs: safeTimestamp(
      firstDefined(project.queuedAtMs, project.queued_at_ms, project.queued_at),
    ),
    admittedAtMs: safeTimestamp(
      firstDefined(
        project.admittedAtMs,
        project.admitted_at_ms,
        project.admitted_at,
      ),
    ),
    blockedReason: safeString(
      firstDefined(project.blockedReason, project.blocked_reason),
      500,
    ),
    counts: normalizeCounts(project),
    budget: normalizeBudget(project),
    humanRequestsPending:
      safeInteger(
        firstDefined(
          project.humanRequestsPending,
          project.human_requests_pending,
          project.pending_human_requests,
        ),
        0,
        1_000_000,
      ) ?? 0,
    approvalsPending:
      safeInteger(
        firstDefined(
          project.approvalsPending,
          project.approvals_pending,
          project.pending_approvals,
        ),
        0,
        1_000_000,
      ) ?? 0,
  };
}

function collectCandidates(root: UnknownRecord): ProjectCandidate[] {
  const candidates: ProjectCandidate[] = [];
  const status = asRecord(root.status);
  const summary = asRecord(root.summary);

  const addArray = (
    value: unknown,
    fallbackStatus?: HarnessProjectStatus,
  ) => {
    if (!Array.isArray(value)) return;
    for (const entry of value.slice(0, 1_000)) {
      candidates.push({ value: entry, status: fallbackStatus });
    }
  };

  addArray(root.projects);
  addArray(root.project_summaries);
  addArray(status?.projects);
  addArray(summary?.projects);
  addArray(root.active_projects, 'active');
  addArray(root.queued_projects, 'queued');

  const queue = asRecord(root.queue);
  addArray(Array.isArray(root.queue) ? root.queue : queue?.projects, 'queued');
  addArray(queue?.items, 'queued');

  if (Array.isArray(root.slots)) {
    root.slots.slice(0, 4).forEach((slotValue, index) => {
      const slot = asRecord(slotValue);
      if (!slot) return;
      const project = firstDefined(slot.project, slot.project_summary);
      if (project) {
        candidates.push({
          value: project,
          status: 'active',
          slot: normalizeSlot(firstDefined(slot.slot, slot.id)) ?? index + 1,
        });
      }
    });
  }

  return candidates;
}

function normalizeSeatPool(value: unknown): HarnessSeatPool {
  const pool = safeString(value, 24)?.toLowerCase();
  if (pool === 'fable' || pool === 'codex' || pool === 'opus') return pool;
  return 'unknown';
}

function normalizeRosterSeats(root: UnknownRecord): HarnessSeatProjection[] {
  if (!Array.isArray(root.roster)) return [];
  const nodes = (Array.isArray(root.nodes) ? root.nodes : [])
    .map(asRecord)
    .filter((node): node is UnknownRecord => node !== null);
  const nodeStatusById = new Map<string, string>();
  for (const node of nodes) {
    const nodeId = safeString(firstDefined(node.id, node.nodeId, node.node_id), 128);
    const status = safeString(firstDefined(node.status, node.state), 32)?.toLowerCase();
    if (nodeId && status) nodeStatusById.set(nodeId, status);
  }

  const activeLeases = (Array.isArray(root.leases) ? root.leases : [])
    .map(asRecord)
    .filter((lease): lease is UnknownRecord => lease !== null)
    .filter((lease) => safeString(lease.status, 32)?.toLowerCase() === 'active');

  const result: HarnessSeatProjection[] = [];
  const seen = new Set<string>();
  for (const value of root.roster.slice(0, 1_000)) {
    const seat = asRecord(value);
    if (!seat) continue;
    const logicalSeat = safeString(
      firstDefined(seat.logicalSeat, seat.logical_seat, seat.id),
      80,
    );
    if (!logicalSeat || seen.has(logicalSeat)) continue;
    seen.add(logicalSeat);

    const leases = activeLeases.filter(
      (lease) =>
        safeString(
          firstDefined(lease.logicalSeat, lease.logical_seat, lease.seat),
          80,
        ) === logicalSeat,
    );
    const runningLease = leases.find((lease) => {
      const nodeId = safeString(firstDefined(lease.nodeId, lease.node_id), 128);
      return (
        nodeId !== null &&
        ['running', 'dispatched'].includes(nodeStatusById.get(nodeId) ?? '')
      );
    });
    const lease = runningLease ?? leases[0] ?? null;
    const enabled = safeBoolean(seat.enabled);
    const state: HarnessSeatState = runningLease
      ? 'running'
      : lease
        ? 'leased'
        : enabled
          ? 'available'
          : 'disabled';

    result.push({
      logicalSeat,
      pool: normalizeSeatPool(seat.pool),
      role: safeString(seat.role, 120),
      physicalAgent: safeString(
        firstDefined(seat.physicalAgent, seat.physical_agent),
        120,
      ),
      enabled,
      state,
      projectId: lease
        ? safeString(firstDefined(lease.projectId, lease.project_id), 128)
        : null,
      nodeId: lease
        ? safeString(firstDefined(lease.nodeId, lease.node_id), 128)
        : null,
      leaseExpiresAtMs: lease
        ? safeTimestamp(
            firstDefined(lease.expiresAtMs, lease.expires_at_ms, lease.expires_at),
          )
        : null,
    });
  }
  return result;
}

function normalizeHumanRequestStatus(value: unknown): HarnessHumanRequestStatus {
  const status = safeString(value, 32)?.toLowerCase();
  if (status === 'open' || status === 'resolved' || status === 'cancelled') {
    return status;
  }
  return 'unknown';
}

function normalizeHumanRequests(
  root: UnknownRecord,
): HarnessHumanRequestProjection[] {
  const source = Array.isArray(root.humanRequests)
    ? root.humanRequests
    : Array.isArray(root.human_requests)
      ? root.human_requests
      : [];
  const requests: HarnessHumanRequestProjection[] = [];
  const seen = new Set<string>();

  for (const value of source.slice(0, 1_000)) {
    const request = asRecord(value);
    if (!request) continue;
    const id = safeString(
      firstDefined(request.id, request.requestId, request.request_id),
      128,
    );
    const projectId = safeString(
      firstDefined(request.projectId, request.project_id),
      128,
    );
    if (!id || !projectId || seen.has(id)) continue;
    seen.add(id);

    requests.push({
      id,
      projectId,
      title: safeString(request.title, 200) ?? 'Human input required',
      assignedTo: safeString(
        firstDefined(request.assignedTo, request.assigned_to),
        120,
      ),
      status: normalizeHumanRequestStatus(request.status),
      dueAtMs: safeTimestamp(
        firstDefined(request.dueAtMs, request.due_at_ms, request.due_at),
      ),
      updatedAtMs: safeTimestamp(
        firstDefined(request.updatedAtMs, request.updated_at_ms, request.updated_at),
      ),
    });
  }

  return requests.sort((a, b) => {
    if (a.status === 'open' && b.status !== 'open') return -1;
    if (a.status !== 'open' && b.status === 'open') return 1;
    const dueA = a.dueAtMs ?? Number.MAX_SAFE_INTEGER;
    const dueB = b.dueAtMs ?? Number.MAX_SAFE_INTEGER;
    if (dueA !== dueB) return dueA - dueB;
    return a.id.localeCompare(b.id);
  });
}

function normalizeSeatSummary(root: UnknownRecord): HarnessSeatSummary {
  const status = asRecord(root.status);
  const summary =
    asRecord(root.seatSummary) ??
    asRecord(root.seat_summary) ??
    asRecord(status?.seatSummary) ??
    asRecord(status?.seat_summary);
  if (summary) {
    return {
      total: readCount(summary, 'total'),
      available: readCount(summary, 'available', 'idle'),
      leased: readCount(summary, 'leased'),
      running: readCount(summary, 'running', 'active'),
      quarantined: readCount(summary, 'quarantined'),
    };
  }

  const rosterSeats = normalizeRosterSeats(root);
  if (rosterSeats.length > 0) {
    return {
      total: rosterSeats.length,
      available: rosterSeats.filter((seat) => seat.state === 'available').length,
      leased: rosterSeats.filter((seat) => seat.state === 'leased').length,
      running: rosterSeats.filter((seat) => seat.state === 'running').length,
      quarantined: 0,
    };
  }

  if (!Array.isArray(root.seats)) return { ...EMPTY_SEATS };
  const seats = root.seats.slice(0, 1_000);
  const states = seats.map((seat) => {
    const record = asRecord(seat);
    return safeString(firstDefined(record?.state, record?.status), 32)?.toLowerCase();
  });
  return {
    total: seats.length,
    available: states.filter((state) => state === 'available' || state === 'idle').length,
    leased: states.filter((state) => state === 'leased').length,
    running: states.filter((state) => state === 'running' || state === 'active').length,
    quarantined: states.filter((state) => state === 'quarantined').length,
  };
}

function recordProjectId(record: UnknownRecord): string | null {
  return safeString(
    firstDefined(record.projectId, record.project_id, record.id),
    128,
  );
}

function enrichProjectsFromSnapshot(
  projects: HarnessProjectProjection[],
  snapshot: UnknownRecord,
): void {
  const nodes = (Array.isArray(snapshot.nodes) ? snapshot.nodes : [])
    .map(asRecord)
    .filter((node): node is UnknownRecord => node !== null);
  const humanRequestSource = Array.isArray(snapshot.humanRequests)
    ? snapshot.humanRequests
    : Array.isArray(snapshot.human_requests)
      ? snapshot.human_requests
      : null;
  const humanRequests = (humanRequestSource ?? [])
    .map(asRecord)
    .filter((request): request is UnknownRecord => request !== null);
  const slots = (Array.isArray(snapshot.slots) ? snapshot.slots : [])
    .map(asRecord)
    .filter((slot): slot is UnknownRecord => slot !== null);

  for (const project of projects) {
    const projectNodes = nodes.filter((node) => recordProjectId(node) === project.id);
    if (projectNodes.length > 0) {
      const nodeStatus = (node: UnknownRecord) =>
        safeString(firstDefined(node.status, node.state), 32)?.toLowerCase();
      project.counts = {
        pending: projectNodes.filter((node) => nodeStatus(node) === 'pending').length,
        ready: projectNodes.filter((node) => nodeStatus(node) === 'ready').length,
        running: projectNodes.filter((node) =>
          ['running', 'dispatched'].includes(nodeStatus(node) ?? ''),
        ).length,
        blocked: projectNodes.filter((node) => nodeStatus(node) === 'blocked').length,
        completed: projectNodes.filter((node) => nodeStatus(node) === 'completed').length,
        failed: projectNodes.filter((node) => nodeStatus(node) === 'failed').length,
        total: projectNodes.length,
      };

      const currentNode =
        projectNodes.find((node) =>
          ['running', 'dispatched'].includes(nodeStatus(node) ?? ''),
        ) ??
        projectNodes.find((node) => nodeStatus(node) === 'ready') ??
        projectNodes.find((node) => nodeStatus(node) === 'blocked') ??
        projectNodes.find((node) => nodeStatus(node) === 'failed') ??
        projectNodes.find((node) => nodeStatus(node) === 'pending');
      if (currentNode) {
        project.currentNode = safeString(
          firstDefined(currentNode.name, currentNode.id),
          160,
        );
        project.phase = safeString(
          firstDefined(currentNode.kind, currentNode.stage),
          80,
        );
        project.plannerSeat ??= safeString(
          firstDefined(currentNode.assignedSeat, currentNode.assigned_seat),
          80,
        );
      }
    }

    if (humanRequestSource !== null) {
      project.humanRequestsPending = humanRequests.filter(
        (request) =>
          recordProjectId(request) === project.id &&
          safeString(request.status, 32)?.toLowerCase() === 'open',
      ).length;
    }

    const slot = slots.find(
      (candidate) =>
        safeString(
          firstDefined(
            candidate.currentProjectId,
            candidate.current_project_id,
            candidate.projectId,
            candidate.project_id,
          ),
          128,
        ) === project.id,
    );
    if (slot) {
      project.slot = normalizeSlot(
        firstDefined(slot.slotNo, slot.slot_no, slot.slot, slot.id),
      );
      project.generation = safeInteger(
        firstDefined(slot.generation, slot.slotGeneration, slot.slot_generation),
        0,
        1_000_000,
      );
      project.plannerSeat = safeString(
        firstDefined(slot.ownerLogicalSeat, slot.owner_logical_seat),
        80,
      );
    }
  }
}

function normalizePreflightReady(preflight: UnknownRecord | null): boolean | null {
  if (!preflight) return null;
  const explicit = optionalBoolean(
    firstDefined(preflight.ready, preflight.ok, preflight.passed, preflight.success),
  );
  if (explicit !== null) return explicit;

  const node = asRecord(preflight.node);
  const disk = asRecord(preflight.disk);
  const checks = [
    optionalBoolean(preflight.supported),
    optionalBoolean(node?.satisfied),
    optionalBoolean(disk?.satisfied),
  ].filter((check): check is boolean => check !== null);
  return checks.length > 0 ? checks.every(Boolean) : null;
}

function normalizePreflightBlockers(preflight: UnknownRecord | null): number {
  if (!preflight) return 0;
  const explicit = safeInteger(
    firstDefined(
      preflight.blockerCount,
      preflight.blocker_count,
      preflight.failedCount,
      preflight.failed_count,
    ),
    0,
    1_000_000,
  );
  if (explicit !== null) return explicit;
  if (Array.isArray(preflight.blockers)) return preflight.blockers.length;

  const compatibility = asRecord(preflight.compatibility_bus_projection);
  const refusalReasons = Array.isArray(compatibility?.refusal_reasons)
    ? compatibility.refusal_reasons.length
    : 0;
  if (refusalReasons > 0) return refusalReasons;
  const node = asRecord(preflight.node);
  const disk = asRecord(preflight.disk);
  return [preflight.supported, node?.satisfied, disk?.satisfied].filter(
    (check) => optionalBoolean(check) === false,
  ).length;
}

function supportedProjectionSchema(root: UnknownRecord): string | null {
  const schemaId = safeString(firstDefined(root.schemaId, root.schema_id), 80);
  const rawVersion = firstDefined(root.schemaVersion, root.schema_version);
  const numericVersion = strictInteger(rawVersion, 0, 1_000_000);
  const control = asRecord(root.control);
  if (
    schemaId === HARNESS_PROJECTION_SCHEMA &&
    numericVersion === 1 &&
    root.mode === 'shadow' &&
    asRecord(root.snapshot) !== null &&
    control !== null &&
    asRecord(root.preflight) !== null &&
    control.dispatch_enabled === false &&
    control.egress_enabled === false &&
    control.spend_enabled === false &&
    control.provisioning_enabled === false &&
    typeof control.compatibility_bus_projection_enabled === 'boolean'
  ) {
    return HARNESS_PROJECTION_SCHEMA;
  }
  const legacyMarker = safeString(rawVersion, 80);
  if (
    (schemaId === HARNESS_LEGACY_PROJECTION_SCHEMA || legacyMarker === HARNESS_LEGACY_PROJECTION_SCHEMA) &&
    root.snapshot === undefined
  ) {
    return HARNESS_LEGACY_PROJECTION_SCHEMA;
  }
  return null;
}

function normalizePreflightScope(
  preflight: UnknownRecord | null,
): HarnessProjectionSnapshot['preflightScope'] {
  if (!preflight) return null;
  const scope = safeString(
    firstDefined(preflight.readiness_scope, preflight.readinessScope),
    80,
  );
  return scope === 'compatibility-bus-projection' ? scope : 'unknown';
}

export function sanitizeHarnessProjection(
  value: unknown,
): HarnessProjectionSnapshot | null {
  const root = asRecord(value);
  if (!root) return null;
  const schemaVersion = supportedProjectionSchema(root);
  if (!schemaVersion) return null;
  const generatedAtMs = safeTimestamp(
    firstDefined(
      root.generatedAtMs,
      root.generated_at_ms,
      root.generatedAt,
      root.generated_at,
    ),
  );
  if (generatedAtMs === null) return null;
  const sequence = strictInteger(
    firstDefined(root.sequence, root.projection_sequence, root.seq),
    0,
  );
  if (sequence === null) return null;
  // HarnessProjector writes a narrow envelope around the store snapshot. Keep
  // envelope metadata/control authoritative while reading project data only
  // from its sanitized snapshot. Flat projections remain supported for a
  // deterministic migration path.
  const projection = asRecord(root.snapshot) ?? root;
  const status = asRecord(projection.status);
  const summary = asRecord(projection.summary);
  const control = asRecord(root.control);
  const preflight = asRecord(root.preflight);
  const compatibility = asRecord(preflight?.compatibility_bus_projection);

  const projectsById = new Map<string, HarnessProjectProjection>();
  for (const candidate of collectCandidates(projection)) {
    const project = normalizeProject(candidate);
    if (project && !projectsById.has(project.id)) {
      projectsById.set(project.id, project);
    }
  }
  const projects = Array.from(projectsById.values()).sort((a, b) => {
    const slotA = a.slot ?? Number.MAX_SAFE_INTEGER;
    const slotB = b.slot ?? Number.MAX_SAFE_INTEGER;
    if (slotA !== slotB) return slotA - slotB;
    return (a.queuedAtMs ?? Number.MAX_SAFE_INTEGER) - (b.queuedAtMs ?? Number.MAX_SAFE_INTEGER);
  });
  enrichProjectsFromSnapshot(projects, projection);
  const seats = normalizeRosterSeats(projection);
  const humanRequests = normalizeHumanRequests(projection);

  const mode = normalizeMode(
    firstDefined(
      root.mode,
      root.harness_mode,
      projection.mode,
      projection.harness_mode,
      status?.mode,
      summary?.mode,
    ),
  );
  const killSwitch = safeBoolean(
    firstDefined(
      control?.killSwitch,
      control?.kill_switch,
      projection.killSwitch,
      projection.kill_switch,
      status?.killSwitch,
      status?.kill_switch,
    ),
  );
  const configuredDispatch = safeBoolean(
    firstDefined(
      control?.dispatchEnabled,
      control?.dispatch_enabled,
      projection.dispatchEnabled,
      projection.dispatch_enabled,
      root.dispatchEnabled,
      root.dispatch_enabled,
      status?.dispatchEnabled,
      status?.dispatch_enabled,
    ),
  );
  const maxLiveProjects =
    safeInteger(
      firstDefined(
        root.maxLiveProjects,
        root.max_live_projects,
        projection.maxLiveProjects,
        projection.max_live_projects,
        status?.maxLiveProjects,
        status?.max_live_projects,
      ),
      1,
      4,
    ) ?? 4;
  const computedLive = projects.filter((project) =>
    ['admitted', 'active', 'blocked'].includes(project.status),
  ).length;
  const computedQueued = projects.filter(
    (project) => project.status === 'queued' || project.status === 'parked',
  ).length;

  return {
    available: true,
    state: 'ready',
    schemaVersion,
    generatedAtMs,
    sequence,
    mode,
    dispatchEnabled: configuredDispatch && !killSwitch,
    admissionMode: normalizeAdmissionMode(
      firstDefined(
        control?.admissionMode,
        control?.admission_mode,
        projection.admissionMode,
        projection.admission_mode,
        status?.admissionMode,
        status?.admission_mode,
      ),
    ),
    killSwitch,
    preflightReady: normalizePreflightReady(preflight),
    preflightBlockers: normalizePreflightBlockers(preflight),
    preflightScope: normalizePreflightScope(preflight),
    shadowBaseUsable: optionalBoolean(
      firstDefined(preflight?.shadow_base_usable, preflight?.shadowBaseUsable),
    ),
    compatibilityProjectionRequested: optionalBoolean(
      firstDefined(compatibility?.requested, control?.compatibility_bus_projection_requested),
    ),
    compatibilityProjectionEffective: optionalBoolean(
      firstDefined(
        compatibility?.effective,
        control?.compatibility_bus_projection_enabled,
      ),
    ),
    maxLiveProjects,
    // Derive occupancy from normalized project states. Producer-provided counts
    // may be stale and historically counted paused projects as live.
    liveProjects: Math.min(computedLive, maxLiveProjects),
    queuedProjects:
      safeInteger(
        firstDefined(
          root.queuedProjects,
          root.queued_projects,
          projection.queuedProjects,
          projection.queued_projects,
          status?.queuedProjects,
          status?.queued_projects,
        ),
        0,
        1_000_000,
      ) ?? computedQueued,
    seatSummary: normalizeSeatSummary(projection),
    seats,
    humanRequests,
    projects,
  };
}

export function readHarnessProjection(
  projectionPath = getHarnessProjectionPath(),
  nowMs = Date.now(),
): HarnessProjectionSnapshot {
  let descriptor: number | null = null;
  try {
    const stat = fs.lstatSync(projectionPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return emptySnapshot('invalid');

    descriptor = fs.openSync(
      projectionPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const openedStat = fs.fstatSync(descriptor);
    if (
      !openedStat.isFile() ||
      openedStat.size <= 0 ||
      openedStat.size > HARNESS_PROJECTION_MAX_BYTES
    ) {
      return emptySnapshot('invalid');
    }

    const raw = fs.readFileSync(descriptor, 'utf-8');
    const sanitized = sanitizeHarnessProjection(JSON.parse(raw));
    if (!sanitized || sanitized.generatedAtMs === null) return emptySnapshot('invalid');
    if (sanitized.generatedAtMs > nowMs + HARNESS_PROJECTION_MAX_FUTURE_SKEW_MS) {
      return emptySnapshot('invalid');
    }
    if (nowMs - sanitized.generatedAtMs > HARNESS_PROJECTION_MAX_AGE_MS) {
      return {
        ...emptySnapshot('stale'),
        schemaVersion: sanitized.schemaVersion,
        generatedAtMs: sanitized.generatedAtMs,
        sequence: sanitized.sequence,
        mode: sanitized.mode,
      };
    }
    return sanitized;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return emptySnapshot(code === 'ENOENT' ? 'missing' : 'invalid');
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The projection is read-only and close failures do not change the result.
      }
    }
  }
}
