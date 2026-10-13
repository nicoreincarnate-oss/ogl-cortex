import { randomUUID } from 'crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'fs';
import { basename, dirname, resolve } from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { PROJECT_SLOT_OWNERS, SHADOW_ROSTER } from './roster.js';
import { SHADOW_SCHEMA_SQL, SHADOW_SCHEMA_VERSION } from './schema.js';
import {
  HARNESS_MODE,
  type AcquireLeaseInput,
  type CreateHumanRequestInput,
  type CreateNodeInput,
  type HarnessControlState,
  type HarnessEvent,
  type HarnessProjectionSnapshot,
  type HarnessStatus,
  type HumanRequest,
  type LeaseListFilter,
  type Project,
  type ProjectListFilter,
  type ProjectSlot,
  type ProjectStatus,
  type ResolveHumanRequestInput,
  type RosterSeat,
  type SeatLease,
  type SeatLeaseStatus,
  type SeatPool,
  type SubmitProjectInput,
  type UpdateNodeInput,
  type WorkflowNode,
  type WorkflowNodeStatus,
} from './types.js';

type DbValue = string | number | bigint | Uint8Array | null;
type DbRow = Record<string, DbValue>;
type LooseRecord = Record<string, unknown>;

const PROJECT_STATUSES: readonly ProjectStatus[] = [
  'queued', 'admitted', 'paused', 'completed', 'cancelled',
];
const NODE_STATUSES: readonly WorkflowNodeStatus[] = [
  'pending', 'ready', 'dispatched', 'running', 'blocked', 'completed', 'failed', 'cancelled',
];
const LEASE_STATUSES: readonly SeatLeaseStatus[] = ['active', 'released', 'expired'];
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_ORG = /^[a-z0-9_-]{1,63}$/;

function requireNode26(): void {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);
  if (!Number.isFinite(major) || major < 26) {
    throw new Error(
      `Compatibility shadow harness requires Node 26+ (found ${process.versions.node}); legacy CortexOS remains available.`,
    );
  }
}

function loadDatabaseSync(): typeof DatabaseSync {
  requireNode26();
  // Deliberately lazy: importing the normal CortexOS daemon under Node 20/22
  // must not resolve node:sqlite before the compatibility feature is selected.
  //
  // The specifier is assembled at runtime so the bundler (esbuild/tsup) cannot
  // statically recognize the node:sqlite builtin and rewrite it to a bare
  // (nonexistent) `require("sqlite")`. Node resolves node:sqlite at runtime.
  const sqliteSpecifier = ['node', 'sqlite'].join(':');
  const sqlite = require(sqliteSpecifier) as typeof import('node:sqlite');
  return sqlite.DatabaseSync;
}

function asRow(value: unknown): DbRow {
  if (!value || typeof value !== 'object') throw new Error('Shadow store row is missing');
  return value as DbRow;
}

function text(row: DbRow, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`Expected text column ${key}`);
  return value;
}

function nullableText(row: DbRow, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error(`Expected nullable text column ${key}`);
  return value;
}

function integer(row: DbRow, key: string): number {
  const value = row[key];
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Expected integer column ${key}`);
  }
  return value;
}

function nullableInteger(row: DbRow, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  return integer(row, key);
}

function bool(row: DbRow, key: string): boolean {
  return integer(row, key) === 1;
}

function optionalString(record: LooseRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof record[key] === 'string') return record[key] as string;
  }
  return undefined;
}

function optionalStringArray(record: LooseRecord, ...keys: string[]): string[] | undefined {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
      return value as string[];
    }
  }
  return undefined;
}

function boundedText(value: unknown, field: string, max: number, required = false): string {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${field} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (required && normalized.length === 0) throw new Error(`${field} is required`);
  if (normalized.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return normalized;
}

function checkedId(value: string | undefined, prefix: string): string {
  const id = value ?? `${prefix}_${randomUUID()}`;
  if (!SAFE_ID.test(id)) throw new Error(`Invalid ${prefix} id`);
  return id;
}

function assertOneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`Invalid ${field}: ${String(value)}`);
  }
  return value as T;
}

/**
 * Durable local compatibility store for the morning-use shadow harness.
 * It is not, and must never be named or represented as, authoritative v2.1.
 */
export class HarnessStore {
  readonly databasePath: string;
  private db: DatabaseSync | null = null;
  private initialized = false;
  private transactionDepth = 0;

  constructor(dbPath: string) {
    if (!dbPath || typeof dbPath !== 'string') throw new Error('A caller-supplied shadow database path is required');
    if (dbPath !== ':memory:' && basename(dbPath).toLowerCase() === 'harness.db') {
      throw new Error('Refusing authoritative-looking harness.db; use harness/shadow-v1.db');
    }
    this.databasePath = dbPath === ':memory:' ? dbPath : resolve(dbPath);
  }

  static open(dbPath: string): HarnessStore {
    const store = new HarnessStore(dbPath);
    store.initialize();
    return store;
  }

  initialize(): HarnessStatus {
    if (this.initialized) return this.getStatus();
    requireNode26();
    if (this.databasePath !== ':memory:') {
      const parent = dirname(this.databasePath);
      const parentExisted = existsSync(parent);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      // The normal path is <ctxRoot>/harness/shadow-v1.db. Never chmod an
      // arbitrary caller-owned directory such as /tmp or a repository root.
      if (!parentExisted || basename(parent).toLowerCase() === 'harness') {
        try { chmodSync(parent, 0o700); } catch { /* non-POSIX filesystem */ }
      }
      const fd = openSync(this.databasePath, 'a', 0o600);
      closeSync(fd);
      try { chmodSync(this.databasePath, 0o600); } catch { /* non-POSIX filesystem */ }
    }

    const SqliteDatabase = loadDatabaseSync();
    const db = new SqliteDatabase(this.databasePath, {
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
      defensive: true,
      timeout: 5_000,
      readBigInts: false,
      allowBareNamedParameters: false,
      allowUnknownNamedParameters: false,
    });
    this.db = db;

    try {
      db.enableLoadExtension(false);
      db.enableDefensive(true);
      db.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA busy_timeout = 5000;
        PRAGMA trusted_schema = OFF;
        PRAGMA recursive_triggers = ON;
      `);
      db.exec(SHADOW_SCHEMA_SQL);
      this.ensureOrgColumn();
      // shadow-v1 may be reopened after a development checkpoint. Refresh the
      // two evolving guards so a durable file cannot retain weaker semantics.
      db.exec(`DROP TRIGGER IF EXISTS project_transition_guard;
        DROP TRIGGER IF EXISTS node_transition_guard;
        DROP TRIGGER IF EXISTS lease_transition_guard;
        DROP TRIGGER IF EXISTS lease_transition_event;`);
      db.exec(SHADOW_SCHEMA_SQL);
      this.withTransaction(() => this.seedFoundation());
      this.verifyFoundation();
      this.initialized = true;
      this.hardenDatabaseFiles();
      return this.getStatus();
    } catch (error) {
      try { db.close(); } catch { /* initialization already failed */ }
      this.db = null;
      throw error;
    }
  }

  close(): void {
    if (!this.db) return;
    this.db.close();
    this.db = null;
    this.initialized = false;
    this.transactionDepth = 0;
  }

  submitProject(input: SubmitProjectInput | LooseRecord): Project {
    const loose = input as LooseRecord;
    const id = checkedId(optionalString(loose, 'id'), 'project');
    const org = boundedText(loose.org ?? 'atrium', 'org', 63, true);
    if (!SAFE_ORG.test(org)) {
      throw new Error('org must contain only lowercase letters, numbers, underscores, and hyphens');
    }
    const title = boundedText(loose.title, 'title', 200, true);
    const description = boundedText(loose.description, 'description', 20_000);
    const rawPriority = loose.priority ?? 50;
    if (typeof rawPriority !== 'number' || !Number.isInteger(rawPriority)
      || rawPriority < 0 || rawPriority > 100) {
      throw new Error('priority must be an integer between 0 and 100');
    }
    const now = Date.now();
    this.withTransaction(() => {
      this.statement(`INSERT INTO projects
        (id,org,title,description,priority,status,revision,created_at_ms,updated_at_ms)
        VALUES (?,?,?,?,?, 'queued',1,?,?)`).run(id, org, title, description, rawPriority, now, now);
    });
    return this.requireProject(id);
  }

  createProject(input: SubmitProjectInput | LooseRecord): Project {
    return this.submitProject(input);
  }

  listProjects(filter: ProjectListFilter | LooseRecord = {}): Project[] {
    this.assertInitialized();
    const rawStatus = (filter as LooseRecord).status;
    if (rawStatus === undefined) {
      return this.statement(`SELECT * FROM projects
        ORDER BY CASE status WHEN 'admitted' THEN 0 WHEN 'queued' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END,
        priority DESC, created_at_ms, id`).all().map((row) => this.mapProject(asRow(row)));
    }
    const statuses = Array.isArray(rawStatus) ? rawStatus : [rawStatus];
    const checked = statuses.map((status) => assertOneOf(status, PROJECT_STATUSES, 'project status'));
    if (checked.length === 0) return [];
    const placeholders = checked.map(() => '?').join(',');
    return this.statement(`SELECT * FROM projects WHERE status IN (${placeholders})
      ORDER BY priority DESC, created_at_ms, id`).all(...checked).map((row) => this.mapProject(asRow(row)));
  }

  getProject(id: string): Project | undefined {
    this.assertInitialized();
    const row = this.statement('SELECT * FROM projects WHERE id = ?').get(id);
    return row ? this.mapProject(asRow(row)) : undefined;
  }

  admitProject(projectId?: string): Project {
    return this.withTransaction(() => {
      const project = projectId
        ? this.requireProject(projectId)
        : this.nextQueuedProject();
      if (project.status !== 'queued') throw new Error(`Project ${project.id} cannot be admitted from ${project.status}`);
      const slotRow = this.statement(`SELECT * FROM project_slots
        WHERE current_project_id IS NULL ORDER BY slot_no LIMIT 1`).get();
      if (!slotRow) throw new Error('No project slot available; four projects are already admitted');
      const slot = this.mapSlot(asRow(slotRow));
      const now = Date.now();
      this.statement(`UPDATE project_slots SET generation = generation + 1,
        current_project_id = ?, updated_at_ms = ? WHERE slot_no = ? AND current_project_id IS NULL`)
        .run(project.id, now, slot.slotNo);
      const boundSlot = this.mapSlot(asRow(this.statement('SELECT * FROM project_slots WHERE slot_no = ?').get(slot.slotNo)));
      this.statement(`UPDATE projects SET status='admitted', slot_no=?, slot_generation=?,
        revision=revision+1, updated_at_ms=? WHERE id=? AND status='queued'`)
        .run(boundSlot.slotNo, boundSlot.generation, now, project.id);
      this.assertSlotCoherence();
      return this.requireProject(project.id);
    });
  }

  pauseProject(projectId: string): Project {
    this.expireLeases();
    return this.withTransaction(() => {
      const project = this.requireProject(projectId);
      if (project.status !== 'admitted') throw new Error(`Project ${projectId} cannot pause from ${project.status}`);
      this.assertNoActiveLease(projectId);
      const liveNode = this.statement(`SELECT id FROM workflow_nodes
        WHERE project_id=? AND status IN ('dispatched','running') LIMIT 1`).get(projectId);
      if (liveNode) throw new Error('Project cannot pause while a workflow node is dispatched or running');
      const now = Date.now();
      this.statement(`UPDATE projects SET status='paused', slot_no=NULL, slot_generation=NULL,
        revision=revision+1, updated_at_ms=? WHERE id=?`)
        .run(now, projectId);
      this.releaseProjectSlot(project, now);
      this.assertSlotCoherence();
      return this.requireProject(projectId);
    });
  }

  parkProject(projectId: string): Project {
    return this.pauseProject(projectId);
  }

  resumeProject(projectId: string): Project {
    return this.withTransaction(() => {
      const project = this.requireProject(projectId);
      if (project.status !== 'paused') throw new Error(`Project ${projectId} cannot resume from ${project.status}`);
      const slotRow = this.statement(`SELECT * FROM project_slots
        WHERE current_project_id IS NULL ORDER BY slot_no LIMIT 1`).get();
      if (!slotRow) throw new Error('No project slot available; four projects are already admitted');
      const slot = this.mapSlot(asRow(slotRow));
      const now = Date.now();
      this.statement(`UPDATE project_slots SET generation=generation+1,
        current_project_id=?, updated_at_ms=? WHERE slot_no=? AND current_project_id IS NULL`)
        .run(projectId, now, slot.slotNo);
      const bound = this.mapSlot(asRow(this.statement('SELECT * FROM project_slots WHERE slot_no=?').get(slot.slotNo)));
      this.statement(`UPDATE projects SET status='admitted', slot_no=?, slot_generation=?,
        revision=revision+1, updated_at_ms=? WHERE id=? AND status='paused'`)
        .run(bound.slotNo, bound.generation, now, projectId);
      this.assertSlotCoherence();
      return this.requireProject(projectId);
    });
  }

  cancelProject(projectId: string, reason = ''): Project {
    return this.withTransaction(() => {
      const project = this.requireProject(projectId);
      if (!['queued', 'admitted', 'paused'].includes(project.status)) {
        throw new Error(`Project ${projectId} cannot cancel from ${project.status}`);
      }
      const now = Date.now();
      this.statement(`UPDATE seat_leases SET status='released', released_at_ms=?, revision=revision+1
        WHERE project_id=? AND status='active'`).run(now, projectId);
      this.statement(`UPDATE workflow_nodes SET status='cancelled', completed_at_ms=?,
        updated_at_ms=?, revision=revision+1
        WHERE project_id=? AND status IN ('pending','ready','dispatched','running','blocked')`)
        .run(now, now, projectId);
      this.statement(`UPDATE human_requests SET status='cancelled', resolved_at_ms=?,
        updated_at_ms=?, revision=revision+1 WHERE project_id=? AND status='open'`)
        .run(now, now, projectId);
      this.statement(`UPDATE projects SET status='cancelled', cancellation_reason=?, completed_at_ms=?,
        slot_no=NULL, slot_generation=NULL, updated_at_ms=?, revision=revision+1 WHERE id=?`)
        .run(boundedText(reason, 'reason', 2_000) || null, now, now, projectId);
      if (project.status === 'admitted') this.releaseProjectSlot(project, now);
      this.assertSlotCoherence();
      return this.requireProject(projectId);
    });
  }

  completeProject(projectId: string): Project {
    this.expireLeases();
    return this.withTransaction(() => {
      const project = this.requireProject(projectId);
      if (project.status !== 'admitted') throw new Error(`Project ${projectId} cannot complete from ${project.status}`);
      this.assertNoActiveLease(projectId);
      if (!this.statement(`SELECT 1 FROM workflow_nodes WHERE project_id=? AND status='completed' LIMIT 1`).get(projectId)) {
        throw new Error('Project cannot complete before at least one workflow node is completed');
      }
      if (this.statement(`SELECT 1 FROM workflow_nodes WHERE project_id=?
        AND status <> 'completed' LIMIT 1`).get(projectId)) {
        throw new Error('Project cannot complete while workflow nodes remain unfinished');
      }
      if (this.statement(`SELECT 1 FROM human_requests WHERE project_id=? AND status='open' LIMIT 1`).get(projectId)) {
        throw new Error('Project cannot complete with open human requests');
      }
      const now = Date.now();
      this.statement(`UPDATE projects SET status='completed', completed_at_ms=?, updated_at_ms=?,
        slot_no=NULL, slot_generation=NULL, revision=revision+1 WHERE id=?`).run(now, now, projectId);
      this.releaseProjectSlot(project, now);
      this.assertSlotCoherence();
      return this.requireProject(projectId);
    });
  }

  seedRoster(): RosterSeat[] {
    this.assertInitialized();
    this.withTransaction(() => this.seedRosterRows());
    this.verifyRoster();
    return this.listRoster();
  }

  listRoster(): RosterSeat[] {
    this.assertInitialized();
    return this.statement(`SELECT * FROM roster_seats ORDER BY
      CASE substr(logical_seat,1,1) WHEN 'f' THEN 0 WHEN 'c' THEN 1 ELSE 2 END,
      CAST(substr(logical_seat,2) AS INTEGER)`).all().map((row) => this.mapRoster(asRow(row)));
  }

  listProjectSlots(): ProjectSlot[] {
    this.assertInitialized();
    return this.statement('SELECT * FROM project_slots ORDER BY slot_no').all()
      .map((row) => this.mapSlot(asRow(row)));
  }

  createNode(input: CreateNodeInput | LooseRecord): WorkflowNode {
    const loose = input as LooseRecord;
    const projectId = optionalString(loose, 'projectId', 'project_id');
    if (!projectId) throw new Error('projectId is required');
    const project = this.requireProject(projectId);
    if (project.status !== 'admitted') throw new Error('Workflow nodes may be created only for admitted projects');
    const id = checkedId(optionalString(loose, 'id'), 'node');
    const nodeKey = boundedText(
      optionalString(loose, 'nodeKey', 'node_key', 'key')
        ?? optionalString(loose, 'name', 'label'),
      'nodeKey', 120, true,
    );
    const name = boundedText(optionalString(loose, 'name', 'label') ?? nodeKey, 'name', 200, true);
    const kind = boundedText(optionalString(loose, 'kind', 'stage', 'role') ?? 'task', 'kind', 100, true);
    const requiredPoolRaw = loose.requiredPool ?? loose.required_pool ?? null;
    const requiredPool = requiredPoolRaw === null || requiredPoolRaw === undefined
      ? null
      : assertOneOf(requiredPoolRaw, ['fable', 'sonnet', 'opus'] as const, 'requiredPool');
    const assignedSeat = optionalString(loose, 'assignedSeat', 'assigned_seat') ?? null;
    if (assignedSeat) this.assertSeatMatchesPool(assignedSeat, requiredPool);
    const dependencies = [...new Set(optionalStringArray(
      loose, 'dependsOn', 'dependencyNodeIds', 'dependency_node_ids',
    ) ?? [])];
    if (dependencies.includes(id)) throw new Error('A node cannot depend on itself');
    for (const dependencyId of dependencies) {
      const dependency = this.requireNode(dependencyId);
      if (dependency.projectId !== projectId) throw new Error('Cross-project node dependencies are forbidden');
    }
    const status: WorkflowNodeStatus = dependencies.every((dependencyId) =>
      this.requireNode(dependencyId).status === 'completed') ? 'ready' : 'pending';
    const inputSummary = boundedText(
      optionalString(loose, 'inputSummary', 'input_summary', 'instructions') ?? '',
      'inputSummary', 10_000,
    );
    const now = Date.now();
    this.withTransaction(() => {
      this.statement(`INSERT INTO workflow_nodes
        (id,project_id,node_key,name,kind,required_pool,assigned_seat,status,input_summary,
         output_summary,bus_task_id,revision,created_at_ms,updated_at_ms)
        VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,1,?,?)`)
        .run(id, projectId, nodeKey, name, kind, requiredPool, assignedSeat, status, inputSummary, now, now);
      const insertDependency = this.statement(
        'INSERT INTO node_dependencies(node_id,depends_on_node_id) VALUES (?,?)',
      );
      for (const dependencyId of dependencies) insertDependency.run(id, dependencyId);
    });
    return this.requireNode(id);
  }

  listNodes(projectId: string): WorkflowNode[] {
    this.assertInitialized();
    return this.statement('SELECT * FROM workflow_nodes WHERE project_id=? ORDER BY created_at_ms,id')
      .all(projectId).map((row) => this.mapNode(asRow(row)));
  }

  updateNode(nodeId: string, input: UpdateNodeInput | LooseRecord): WorkflowNode {
    const loose = input as LooseRecord;
    const current = this.requireNode(nodeId);
    if (['completed', 'failed', 'cancelled'].includes(current.status)) {
      throw new Error(`Workflow node ${nodeId} is terminal (${current.status})`);
    }
    let requested = loose.status ?? loose.state;
    if (requested === 'accepted') requested = 'completed';
    const status = assertOneOf(requested, NODE_STATUSES, 'node status');
    if (status === 'ready' && !this.dependenciesComplete(nodeId)) {
      throw new Error('Node cannot become ready until every dependency is completed');
    }
    const assignedSeat = loose.assignedSeat !== undefined || loose.assigned_seat !== undefined
      ? (optionalString(loose, 'assignedSeat', 'assigned_seat') ?? null)
      : current.assignedSeat;
    if (assignedSeat) this.assertSeatMatchesPool(assignedSeat, current.requiredPool);
    const outputCandidate = loose.outputSummary ?? loose.output_summary;
    const outputSummary = outputCandidate === undefined
      ? current.outputSummary
      : boundedText(outputCandidate, 'outputSummary', 10_000) || null;
    const requestedBusTaskId = optionalString(
      loose, 'busTaskId', 'bus_task_id', 'legacyTaskId', 'legacy_task_id',
    );
    const busTaskId = requestedBusTaskId ?? current.busTaskId;
    if (current.busTaskId && requestedBusTaskId && requestedBusTaskId !== current.busTaskId) {
      throw new Error('A node bus task binding is immutable');
    }
    if (requestedBusTaskId && !current.busTaskId && status !== 'dispatched') {
      throw new Error('A busTaskId may be bound only while projecting a node as dispatched');
    }
    if (status === 'dispatched' && !busTaskId) {
      throw new Error('A compatibility-dispatched node requires a durable busTaskId');
    }
    const now = Date.now();
    this.withTransaction(() => {
      this.statement(`UPDATE workflow_nodes SET status=?, assigned_seat=?, output_summary=?, bus_task_id=?,
        completed_at_ms=?, updated_at_ms=?, revision=revision+1 WHERE id=?`)
        .run(
          status,
          assignedSeat,
          outputSummary,
          busTaskId,
          ['completed', 'failed', 'cancelled'].includes(status) ? now : current.completedAtMs,
          now,
          nodeId,
        );
      if (status === 'completed') this.refreshReadyNodes(current.projectId, now);
    });
    return this.requireNode(nodeId);
  }

  createHumanRequest(input: CreateHumanRequestInput | LooseRecord): HumanRequest {
    const loose = input as LooseRecord;
    const projectId = optionalString(loose, 'projectId', 'project_id');
    if (!projectId) throw new Error('projectId is required');
    const project = this.requireProject(projectId);
    if (['completed', 'cancelled'].includes(project.status)) {
      throw new Error('Cannot create a human request for a terminal project');
    }
    const id = checkedId(optionalString(loose, 'id'), 'human');
    const title = boundedText(loose.title, 'title', 200, true);
    const description = boundedText(loose.description, 'description', 20_000);
    const assignedTo = optionalString(loose, 'assignedTo', 'assigned_to') ?? null;
    const dueRaw = loose.dueAtMs ?? loose.due_at_ms ?? null;
    if (dueRaw !== null && (typeof dueRaw !== 'number' || !Number.isSafeInteger(dueRaw))) {
      throw new Error('dueAtMs must be an integer timestamp or null');
    }
    const now = Date.now();
    this.withTransaction(() => {
      this.statement(`INSERT INTO human_requests
        (id,project_id,title,description,assigned_to,status,response,due_at_ms,revision,created_at_ms,updated_at_ms)
        VALUES (?,?,?,?,?,'open',NULL,?,1,?,?)`)
        .run(id, projectId, title, description, assignedTo, dueRaw, now, now);
    });
    return this.requireHumanRequest(id);
  }

  listHumanRequests(projectId?: string): HumanRequest[] {
    this.assertInitialized();
    const rows = projectId
      ? this.statement('SELECT * FROM human_requests WHERE project_id=? ORDER BY created_at_ms,id').all(projectId)
      : this.statement('SELECT * FROM human_requests ORDER BY created_at_ms,id').all();
    return rows.map((row) => this.mapHumanRequest(asRow(row)));
  }

  resolveHumanRequest(
    requestId: string,
    input: ResolveHumanRequestInput | string = {},
  ): HumanRequest {
    const current = this.requireHumanRequest(requestId);
    if (current.status !== 'open') throw new Error(`Human request ${requestId} is already ${current.status}`);
    const normalized = typeof input === 'string' ? { response: input } : input;
    const status = normalized.status ?? 'resolved';
    if (status !== 'resolved' && status !== 'cancelled') throw new Error('Invalid human request resolution status');
    const response = normalized.response === undefined
      ? null
      : boundedText(normalized.response, 'response', 20_000) || null;
    const now = Date.now();
    this.withTransaction(() => {
      this.statement(`UPDATE human_requests SET status=?, response=?, resolved_at_ms=?, updated_at_ms=?,
        revision=revision+1 WHERE id=?`).run(status, response, now, now, requestId);
    });
    return this.requireHumanRequest(requestId);
  }

  acquireLease(input: AcquireLeaseInput | LooseRecord): SeatLease {
    this.expireLeases();
    const loose = input as LooseRecord;
    const logicalSeat = optionalString(loose, 'logicalSeat', 'logical_seat');
    const projectId = optionalString(loose, 'projectId', 'project_id');
    if (!logicalSeat || !projectId) throw new Error('logicalSeat and projectId are required');
    const project = this.requireProject(projectId);
    if (project.status !== 'admitted') throw new Error('Seat leases require an admitted project');
    const seat = this.statement('SELECT * FROM roster_seats WHERE logical_seat=?').get(logicalSeat);
    if (!seat) throw new Error(`Unknown logical seat ${logicalSeat}`);
    const nodeId = optionalString(loose, 'nodeId', 'node_id') ?? null;
    if (nodeId) {
      const node = this.requireNode(nodeId);
      if (node.projectId !== projectId) throw new Error('Lease node belongs to a different project');
      this.assertSeatMatchesPool(logicalSeat, node.requiredPool);
      if (node.assignedSeat && node.assignedSeat !== logicalSeat) {
        throw new Error(`Lease seat ${logicalSeat} does not match node assignment ${node.assignedSeat}`);
      }
    }
    const ttlRaw = loose.ttlMs ?? loose.ttl_ms ?? 15 * 60 * 1000;
    if (typeof ttlRaw !== 'number' || !Number.isInteger(ttlRaw)
      || ttlRaw < 1_000 || ttlRaw > 24 * 60 * 60 * 1000) {
      throw new Error('ttlMs must be between 1 second and 24 hours');
    }
    const id = checkedId(optionalString(loose, 'id'), 'lease');
    const now = Date.now();
    return this.withTransaction(() => {
      if (this.statement(`SELECT id FROM seat_leases WHERE logical_seat=? AND status='active'`).get(logicalSeat)) {
        throw new Error(`Logical seat ${logicalSeat} already has an active lease`);
      }
      this.statement(`INSERT INTO seat_leases
        (id,logical_seat,project_id,node_id,status,acquired_at_ms,expires_at_ms,released_at_ms,revision)
        VALUES (?,?,?,?,'active',?,?,NULL,1)`)
        .run(id, logicalSeat, projectId, nodeId, now, now + ttlRaw);
      return this.requireLease(id);
    });
  }

  leaseSeat(input: AcquireLeaseInput | LooseRecord): SeatLease {
    return this.acquireLease(input);
  }

  releaseLease(leaseId: string): SeatLease {
    return this.withTransaction(() => {
      const lease = this.requireLease(leaseId);
      if (lease.status !== 'active') throw new Error(`Lease ${leaseId} is already ${lease.status}`);
      const now = Date.now();
      this.statement(`UPDATE seat_leases SET status='released', released_at_ms=?, revision=revision+1
        WHERE id=? AND status='active'`).run(now, leaseId);
      return this.requireLease(leaseId);
    });
  }

  releaseSeat(leaseId: string): SeatLease {
    return this.releaseLease(leaseId);
  }

  renewLease(leaseId: string, ttlMs = 24 * 60 * 60 * 1_000): SeatLease {
    if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 24 * 60 * 60 * 1_000) {
      throw new Error('ttlMs must be between 1 second and 24 hours');
    }
    return this.withTransaction(() => {
      const lease = this.requireLease(leaseId);
      if (lease.status !== 'active') throw new Error(`Lease ${leaseId} is already ${lease.status}`);
      const now = Date.now();
      const nextExpiry = now + ttlMs;
      if (nextExpiry <= lease.expiresAtMs) return lease;
      this.statement(`UPDATE seat_leases SET expires_at_ms=?, revision=revision+1
        WHERE id=? AND status='active'`).run(nextExpiry, leaseId);
      return this.requireLease(leaseId);
    });
  }

  listLeases(filter: LeaseListFilter | LooseRecord = {}): SeatLease[] {
    this.expireLeases();
    const loose = filter as LooseRecord;
    const clauses: string[] = [];
    const values: string[] = [];
    const projectId = optionalString(loose, 'projectId', 'project_id');
    const logicalSeat = optionalString(loose, 'logicalSeat', 'logical_seat');
    if (projectId) { clauses.push('project_id=?'); values.push(projectId); }
    if (logicalSeat) { clauses.push('logical_seat=?'); values.push(logicalSeat); }
    if (loose.status !== undefined) {
      clauses.push('status=?');
      values.push(assertOneOf(loose.status, LEASE_STATUSES, 'lease status'));
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.statement(`SELECT * FROM seat_leases ${where} ORDER BY acquired_at_ms,id`)
      .all(...values).map((row) => this.mapLease(asRow(row)));
  }

  listEvents(limit = 100, projectId?: string): HarnessEvent[] {
    this.assertInitialized();
    if (!Number.isInteger(limit) || limit < 0 || limit > 10_000) throw new Error('event limit must be 0..10000');
    if (limit === 0) return [];
    const rows = projectId
      ? this.statement('SELECT * FROM harness_events WHERE project_id=? ORDER BY seq DESC LIMIT ?').all(projectId, limit)
      : this.statement('SELECT * FROM harness_events ORDER BY seq DESC LIMIT ?').all(limit);
    return rows.map((row) => this.mapEvent(asRow(row)));
  }

  getStatus(): HarnessStatus {
    this.assertInitialized();
    this.expireLeases();
    const control = this.getControlState();
    const counts: Record<ProjectStatus, number> = {
      queued: 0, admitted: 0, paused: 0, completed: 0, cancelled: 0,
    };
    for (const row of this.statement('SELECT status,COUNT(*) AS count FROM projects GROUP BY status').all()) {
      const record = asRow(row);
      counts[assertOneOf(text(record, 'status'), PROJECT_STATUSES, 'project status')] = integer(record, 'count');
    }
    return {
      mode: HARNESS_MODE,
      productionAuthoritative: false,
      databasePath: this.databasePath,
      control,
      slots: this.listProjectSlots(),
      projectCounts: counts,
      activeProjectCount: counts.admitted,
      queuedProjectCount: counts.queued,
      rosterSeatCount: integer(asRow(this.statement('SELECT COUNT(*) AS count FROM roster_seats').get()), 'count'),
    };
  }

  getProjectionSnapshot(): HarnessProjectionSnapshot {
    this.assertInitialized();
    const projects = this.listProjects();
    const allNodeRows = this.statement('SELECT * FROM workflow_nodes ORDER BY project_id,created_at_ms,id').all();
    const nodes = allNodeRows.map((row) => this.mapNode(asRow(row)));
    return {
      mode: HARNESS_MODE,
      productionAuthoritative: false,
      generatedAtMs: Date.now(),
      control: this.getControlState(),
      slots: this.listProjectSlots(),
      projects: projects.map((project) => ({
        id: project.id,
        org: project.org,
        title: project.title,
        priority: project.priority,
        status: project.status,
        slotNo: project.slotNo,
        slotGeneration: project.slotGeneration,
        revision: project.revision,
        createdAtMs: project.createdAtMs,
        updatedAtMs: project.updatedAtMs,
      })),
      roster: this.listRoster(),
      nodes: nodes.map((node) => ({
        id: node.id,
        projectId: node.projectId,
        nodeKey: node.nodeKey,
        name: node.name,
        kind: node.kind,
        requiredPool: node.requiredPool,
        assignedSeat: node.assignedSeat,
        status: node.status,
        busTaskId: node.busTaskId,
        dependsOn: node.dependsOn,
        revision: node.revision,
        updatedAtMs: node.updatedAtMs,
      })),
      humanRequests: this.listHumanRequests().map((request) => ({
        id: request.id,
        projectId: request.projectId,
        title: request.title,
        assignedTo: request.assignedTo,
        status: request.status,
        dueAtMs: request.dueAtMs,
        revision: request.revision,
        updatedAtMs: request.updatedAtMs,
      })),
      leases: this.listLeases().map((lease) => ({
        id: lease.id,
        logicalSeat: lease.logicalSeat,
        projectId: lease.projectId,
        nodeId: lease.nodeId,
        status: lease.status,
        expiresAtMs: lease.expiresAtMs,
      })),
      recentEvents: this.listEvents(200).map(({ metadata: _metadata, ...event }) => event),
    };
  }

  private seedFoundation(): void {
    const now = Date.now();
    this.statement(`INSERT OR IGNORE INTO shadow_meta
      (singleton,schema_version,store_kind,production_authoritative,initialized_at_ms)
      VALUES (1,1,'compatibility-shadow',0,?)`).run(now);
    this.statement(`INSERT OR IGNORE INTO control_state
      (singleton,mode,dispatch_enabled,provisioning_enabled,provider_calls_enabled,spending_enabled,
       canonical_git_mutation_enabled,external_egress_enabled,initialized_at_ms)
      VALUES (1,'compatibility-shadow',0,0,0,0,0,0,?)`).run(now);
    const insertSlot = this.statement(`INSERT OR IGNORE INTO project_slots
      (slot_no,owner_logical_seat,generation,current_project_id,updated_at_ms) VALUES (?,?,0,NULL,?)`);
    PROJECT_SLOT_OWNERS.forEach((owner, index) => insertSlot.run(index + 1, owner, now));
    this.seedRosterRows();
    if (!this.statement("SELECT 1 FROM harness_events WHERE event_type='roster.seeded' LIMIT 1").get()) {
      this.statement(`INSERT INTO harness_events
        (id,event_type,entity_type,entity_id,project_id,message,metadata_json,created_at_ms)
        VALUES (?,'roster.seeded','roster','shadow-v1',NULL,'Exact disabled compatibility roster seeded',?,?)`)
        .run(randomUUID(), JSON.stringify({ seatCount: 16 }), now);
    }
  }

  private ensureOrgColumn(): void {
    const columns = this.statement('PRAGMA table_info(projects)').all()
      .map((row) => text(asRow(row), 'name'));
    if (columns.includes('org')) return;
    const db = this.db;
    if (!db) throw new Error('Shadow store is not initialized');
    db.exec(`ALTER TABLE projects ADD COLUMN org TEXT NOT NULL DEFAULT 'atrium'
      CHECK (length(org) BETWEEN 1 AND 63 AND org NOT GLOB '*[^a-z0-9_-]*')`);
  }

  private seedRosterRows(): void {
    const insert = this.statement(`INSERT OR IGNORE INTO roster_seats
      (logical_seat,pool,role,desired_runtime,desired_model,desired_profile,physical_agent,enabled)
      VALUES (?,?,?,?,?,?,?,0)`);
    for (const seat of SHADOW_ROSTER) {
      insert.run(
        seat.logicalSeat, seat.pool, seat.role, seat.desiredRuntime,
        seat.desiredModel, seat.desiredProfile, seat.physicalAgent,
      );
    }
  }

  private verifyFoundation(): void {
    const meta = asRow(this.statement('SELECT * FROM shadow_meta WHERE singleton=1').get());
    if (integer(meta, 'schema_version') !== SHADOW_SCHEMA_VERSION
      || text(meta, 'store_kind') !== HARNESS_MODE
      || integer(meta, 'production_authoritative') !== 0) {
      throw new Error('Database is not a compatible shadow-v1 store');
    }
    const control = this.getControlStateRaw();
    if (control.mode !== HARNESS_MODE || control.productionAuthoritative
      || control.dispatchEnabled || control.provisioningEnabled || control.providerCallsEnabled
      || control.spendingEnabled || control.canonicalGitMutationEnabled || control.externalEgressEnabled) {
      throw new Error('Shadow control state is not fail-closed');
    }
    const slots = this.statement('SELECT * FROM project_slots ORDER BY slot_no').all().map((row) => this.mapSlot(asRow(row)));
    if (slots.length !== 4 || slots.some((slot, index) =>
      slot.slotNo !== index + 1 || slot.ownerLogicalSeat !== PROJECT_SLOT_OWNERS[index])) {
      throw new Error('Shadow store requires exactly four durable project slots');
    }
    this.verifyRoster();
    this.assertSlotCoherence();
    const fk = this.statement('PRAGMA foreign_key_check').all();
    if (fk.length > 0) throw new Error('Shadow store foreign-key check failed');
  }

  private verifyRoster(): void {
    const actual = this.statement('SELECT * FROM roster_seats ORDER BY logical_seat').all()
      .map((row) => this.mapRoster(asRow(row)));
    if (actual.length !== SHADOW_ROSTER.length) throw new Error('Shadow roster must contain exactly 16 seats');
    const expectedByAlias = new Map(SHADOW_ROSTER.map((seat) => [seat.logicalSeat, seat]));
    for (const seat of actual) {
      const expected = expectedByAlias.get(seat.logicalSeat);
      if (!expected || JSON.stringify(seat) !== JSON.stringify(expected)) {
        throw new Error(`Shadow roster mismatch at ${seat.logicalSeat}`);
      }
    }
  }

  private getControlState(): HarnessControlState {
    this.assertInitialized();
    return this.getControlStateRaw();
  }

  private getControlStateRaw(): HarnessControlState {
    const row = asRow(this.statement('SELECT * FROM control_state WHERE singleton=1').get());
    return {
      mode: HARNESS_MODE,
      productionAuthoritative: false,
      dispatchEnabled: bool(row, 'dispatch_enabled') as false,
      provisioningEnabled: bool(row, 'provisioning_enabled') as false,
      providerCallsEnabled: bool(row, 'provider_calls_enabled') as false,
      spendingEnabled: bool(row, 'spending_enabled') as false,
      canonicalGitMutationEnabled: bool(row, 'canonical_git_mutation_enabled') as false,
      externalEgressEnabled: bool(row, 'external_egress_enabled') as false,
      schemaVersion: SHADOW_SCHEMA_VERSION,
      initializedAtMs: integer(row, 'initialized_at_ms'),
    };
  }

  private nextQueuedProject(): Project {
    const row = this.statement(`SELECT * FROM projects WHERE status='queued'
      ORDER BY priority DESC,created_at_ms,id LIMIT 1`).get();
    if (!row) throw new Error('No queued project is available to admit');
    return this.mapProject(asRow(row));
  }

  private requireProject(id: string): Project {
    const row = this.statement('SELECT * FROM projects WHERE id=?').get(id);
    if (!row) throw new Error(`Project ${id} not found`);
    return this.mapProject(asRow(row));
  }

  private requireNode(id: string): WorkflowNode {
    const row = this.statement('SELECT * FROM workflow_nodes WHERE id=?').get(id);
    if (!row) throw new Error(`Workflow node ${id} not found`);
    return this.mapNode(asRow(row));
  }

  private requireHumanRequest(id: string): HumanRequest {
    const row = this.statement('SELECT * FROM human_requests WHERE id=?').get(id);
    if (!row) throw new Error(`Human request ${id} not found`);
    return this.mapHumanRequest(asRow(row));
  }

  private requireLease(id: string): SeatLease {
    const row = this.statement('SELECT * FROM seat_leases WHERE id=?').get(id);
    if (!row) throw new Error(`Seat lease ${id} not found`);
    return this.mapLease(asRow(row));
  }

  private releaseProjectSlot(project: Project, now: number): void {
    if (project.slotNo === null || project.slotGeneration === null) {
      throw new Error(`Admitted project ${project.id} has no slot binding`);
    }
    const result = this.statement(`UPDATE project_slots SET current_project_id=NULL,updated_at_ms=?
      WHERE slot_no=? AND generation=? AND current_project_id=?`)
      .run(now, project.slotNo, project.slotGeneration, project.id) as { changes: number | bigint };
    if (Number(result.changes) !== 1) throw new Error('Project slot binding changed concurrently');
  }

  private assertSlotCoherence(): void {
    const mismatch = this.statement(`
      SELECT p.id FROM projects p
      LEFT JOIN project_slots s ON s.slot_no=p.slot_no
      WHERE p.status='admitted'
        AND (p.slot_no IS NULL OR p.slot_generation IS NULL OR s.current_project_id IS NOT p.id OR s.generation<>p.slot_generation)
      UNION ALL
      SELECT s.current_project_id FROM project_slots s
      LEFT JOIN projects p ON p.id=s.current_project_id
      WHERE s.current_project_id IS NOT NULL
        AND (p.id IS NULL OR p.status<>'admitted' OR p.slot_no<>s.slot_no OR p.slot_generation<>s.generation)
      LIMIT 1`).get();
    if (mismatch) throw new Error('Project/slot coherence violation');
    const admitted = integer(asRow(this.statement("SELECT COUNT(*) AS count FROM projects WHERE status='admitted'").get()), 'count');
    if (admitted > 4) throw new Error('Four-project admission cap violated');
  }

  private assertNoActiveLease(projectId: string): void {
    if (this.statement("SELECT id FROM seat_leases WHERE project_id=? AND status='active' LIMIT 1").get(projectId)) {
      throw new Error('Project has active seat leases');
    }
  }

  private assertSeatMatchesPool(logicalSeat: string, requiredPool: SeatPool | null): void {
    const row = this.statement('SELECT pool FROM roster_seats WHERE logical_seat=?').get(logicalSeat);
    if (!row) throw new Error(`Unknown logical seat ${logicalSeat}`);
    if (requiredPool && text(asRow(row), 'pool') !== requiredPool) {
      throw new Error(`Seat ${logicalSeat} does not satisfy required pool ${requiredPool}`);
    }
  }

  private dependenciesComplete(nodeId: string): boolean {
    return !this.statement(`SELECT 1 FROM node_dependencies d
      JOIN workflow_nodes parent ON parent.id=d.depends_on_node_id
      WHERE d.node_id=? AND parent.status<>'completed' LIMIT 1`).get(nodeId);
  }

  private refreshReadyNodes(projectId: string, now: number): void {
    const rows = this.statement(`SELECT n.id FROM workflow_nodes n
      WHERE n.project_id=? AND n.status='pending'
      AND NOT EXISTS (
        SELECT 1 FROM node_dependencies d JOIN workflow_nodes parent ON parent.id=d.depends_on_node_id
        WHERE d.node_id=n.id AND parent.status<>'completed'
      ) ORDER BY n.created_at_ms,n.id`).all(projectId);
    for (const row of rows) {
      this.statement(`UPDATE workflow_nodes SET status='ready',updated_at_ms=?,revision=revision+1 WHERE id=?`)
        .run(now, text(asRow(row), 'id'));
    }
  }

  private expireLeases(): void {
    if (!this.db || !this.initialized) return;
    const now = Date.now();
    this.withTransaction(() => {
      this.statement(`UPDATE seat_leases SET status='expired',released_at_ms=?,revision=revision+1
        WHERE status='active' AND expires_at_ms<=?`).run(now, now);
    });
  }

  private mapProject(row: DbRow): Project {
    return {
      id: text(row, 'id'),
      org: text(row, 'org'),
      title: text(row, 'title'),
      description: text(row, 'description'),
      priority: integer(row, 'priority'),
      status: assertOneOf(text(row, 'status'), PROJECT_STATUSES, 'project status'),
      slotNo: nullableInteger(row, 'slot_no'),
      slotGeneration: nullableInteger(row, 'slot_generation'),
      revision: integer(row, 'revision'),
      createdAtMs: integer(row, 'created_at_ms'),
      updatedAtMs: integer(row, 'updated_at_ms'),
      completedAtMs: nullableInteger(row, 'completed_at_ms'),
      cancellationReason: nullableText(row, 'cancellation_reason'),
    };
  }

  private hardenDatabaseFiles(): void {
    if (this.databasePath === ':memory:') return;
    for (const path of [this.databasePath, `${this.databasePath}-wal`, `${this.databasePath}-shm`]) {
      if (!existsSync(path)) continue;
      try { chmodSync(path, 0o600); } catch { /* non-POSIX filesystem */ }
    }
  }

  private mapSlot(row: DbRow): ProjectSlot {
    return {
      slotNo: integer(row, 'slot_no'),
      ownerLogicalSeat: text(row, 'owner_logical_seat'),
      generation: integer(row, 'generation'),
      currentProjectId: nullableText(row, 'current_project_id'),
      updatedAtMs: integer(row, 'updated_at_ms'),
    };
  }

  private mapRoster(row: DbRow): RosterSeat {
    return {
      logicalSeat: text(row, 'logical_seat'),
      pool: assertOneOf(text(row, 'pool'), ['fable', 'sonnet', 'opus'] as const, 'seat pool'),
      role: text(row, 'role'),
      desiredRuntime: assertOneOf(text(row, 'desired_runtime'), ['claude-code'] as const, 'runtime'),
      desiredModel: assertOneOf(text(row, 'desired_model'), ['fable-5', 'sonnet-5.5', 'opus-4.8'] as const, 'model'),
      desiredProfile: 'ultra',
      physicalAgent: text(row, 'physical_agent'),
      enabled: false,
    };
  }

  private mapNode(row: DbRow): WorkflowNode {
    const id = text(row, 'id');
    return {
      id,
      projectId: text(row, 'project_id'),
      nodeKey: text(row, 'node_key'),
      name: text(row, 'name'),
      kind: text(row, 'kind'),
      requiredPool: nullableText(row, 'required_pool') as SeatPool | null,
      assignedSeat: nullableText(row, 'assigned_seat'),
      status: assertOneOf(text(row, 'status'), NODE_STATUSES, 'node status'),
      dependsOn: this.statement(`SELECT depends_on_node_id FROM node_dependencies
        WHERE node_id=? ORDER BY depends_on_node_id`).all(id).map((dep) => text(asRow(dep), 'depends_on_node_id')),
      inputSummary: text(row, 'input_summary'),
      outputSummary: nullableText(row, 'output_summary'),
      busTaskId: nullableText(row, 'bus_task_id'),
      revision: integer(row, 'revision'),
      createdAtMs: integer(row, 'created_at_ms'),
      updatedAtMs: integer(row, 'updated_at_ms'),
      completedAtMs: nullableInteger(row, 'completed_at_ms'),
    };
  }

  private mapHumanRequest(row: DbRow): HumanRequest {
    return {
      id: text(row, 'id'),
      projectId: text(row, 'project_id'),
      title: text(row, 'title'),
      description: text(row, 'description'),
      assignedTo: nullableText(row, 'assigned_to'),
      status: assertOneOf(text(row, 'status'), ['open', 'resolved', 'cancelled'] as const, 'human request status'),
      response: nullableText(row, 'response'),
      dueAtMs: nullableInteger(row, 'due_at_ms'),
      revision: integer(row, 'revision'),
      createdAtMs: integer(row, 'created_at_ms'),
      updatedAtMs: integer(row, 'updated_at_ms'),
      resolvedAtMs: nullableInteger(row, 'resolved_at_ms'),
    };
  }

  private mapLease(row: DbRow): SeatLease {
    return {
      id: text(row, 'id'),
      logicalSeat: text(row, 'logical_seat'),
      projectId: text(row, 'project_id'),
      nodeId: nullableText(row, 'node_id'),
      status: assertOneOf(text(row, 'status'), LEASE_STATUSES, 'lease status'),
      acquiredAtMs: integer(row, 'acquired_at_ms'),
      expiresAtMs: integer(row, 'expires_at_ms'),
      releasedAtMs: nullableInteger(row, 'released_at_ms'),
      revision: integer(row, 'revision'),
    };
  }

  private mapEvent(row: DbRow): HarnessEvent {
    let metadata: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(text(row, 'metadata_json')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
    } catch { /* schema already requires valid JSON */ }
    return {
      seq: integer(row, 'seq'),
      id: text(row, 'id'),
      eventType: text(row, 'event_type'),
      entityType: text(row, 'entity_type'),
      entityId: text(row, 'entity_id'),
      projectId: nullableText(row, 'project_id'),
      message: text(row, 'message'),
      metadata,
      createdAtMs: integer(row, 'created_at_ms'),
    };
  }

  private statement(sql: string): ReturnType<DatabaseSync['prepare']> {
    const db = this.db;
    if (!db) throw new Error('Shadow store is not initialized');
    return db.prepare(sql);
  }

  private assertInitialized(): void {
    if (!this.db || !this.initialized) throw new Error('Shadow store is not initialized');
  }

  private withTransaction<T>(fn: () => T): T {
    const db = this.db;
    if (!db) throw new Error('Shadow store is not initialized');
    if (this.transactionDepth > 0) return fn();
    db.exec('BEGIN IMMEDIATE');
    this.transactionDepth += 1;
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* preserve original failure */ }
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }
}
