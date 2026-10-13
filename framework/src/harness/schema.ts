/**
 * Small local compatibility schema. This is intentionally unrelated to and
 * must never install migrations/harness/0021_v21.sql.
 */
export const SHADOW_SCHEMA_VERSION = 1 as const;

export const SHADOW_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS shadow_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  store_kind TEXT NOT NULL CHECK (store_kind = 'compatibility-shadow'),
  production_authoritative INTEGER NOT NULL CHECK (production_authoritative = 0),
  initialized_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS control_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  mode TEXT NOT NULL CHECK (mode = 'compatibility-shadow'),
  dispatch_enabled INTEGER NOT NULL CHECK (dispatch_enabled = 0),
  provisioning_enabled INTEGER NOT NULL CHECK (provisioning_enabled = 0),
  provider_calls_enabled INTEGER NOT NULL CHECK (provider_calls_enabled = 0),
  spending_enabled INTEGER NOT NULL CHECK (spending_enabled = 0),
  canonical_git_mutation_enabled INTEGER NOT NULL CHECK (canonical_git_mutation_enabled = 0),
  external_egress_enabled INTEGER NOT NULL CHECK (external_egress_enabled = 0),
  initialized_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL DEFAULT 'atrium'
    CHECK (length(org) BETWEEN 1 AND 63 AND org NOT GLOB '*[^a-z0-9_-]*'),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 20000),
  priority INTEGER NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
  status TEXT NOT NULL CHECK (status IN ('queued','admitted','paused','completed','cancelled')),
  slot_no INTEGER CHECK (slot_no BETWEEN 1 AND 4),
  slot_generation INTEGER CHECK (slot_generation >= 1),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  cancellation_reason TEXT CHECK (cancellation_reason IS NULL OR length(cancellation_reason) <= 2000),
  CHECK ((slot_no IS NULL) = (slot_generation IS NULL))
) STRICT;

CREATE TABLE IF NOT EXISTS project_slots (
  slot_no INTEGER PRIMARY KEY CHECK (slot_no BETWEEN 1 AND 4),
  owner_logical_seat TEXT NOT NULL UNIQUE,
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  current_project_id TEXT UNIQUE REFERENCES projects(id),
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS roster_seats (
  logical_seat TEXT PRIMARY KEY,
  pool TEXT NOT NULL CHECK (pool IN ('fable','sonnet','opus')),
  role TEXT NOT NULL,
  desired_runtime TEXT NOT NULL CHECK (desired_runtime IN ('claude-code')),
  desired_model TEXT NOT NULL CHECK (desired_model IN ('fable-5','sonnet-5.5','opus-4.8')),
  desired_profile TEXT NOT NULL CHECK (desired_profile = 'ultra'),
  physical_agent TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL CHECK (enabled = 0)
) STRICT;

CREATE TABLE IF NOT EXISTS workflow_nodes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  node_key TEXT NOT NULL CHECK (length(node_key) BETWEEN 1 AND 120),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 100),
  required_pool TEXT CHECK (required_pool IN ('fable','sonnet','opus')),
  assigned_seat TEXT REFERENCES roster_seats(logical_seat),
  status TEXT NOT NULL CHECK (status IN ('pending','ready','dispatched','running','blocked','completed','failed','cancelled')),
  input_summary TEXT NOT NULL DEFAULT '' CHECK (length(input_summary) <= 10000),
  output_summary TEXT CHECK (output_summary IS NULL OR length(output_summary) <= 10000),
  bus_task_id TEXT UNIQUE CHECK (bus_task_id IS NULL OR length(bus_task_id) BETWEEN 1 AND 200),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  UNIQUE(project_id, node_key),
  UNIQUE(project_id, name)
) STRICT;

CREATE TABLE IF NOT EXISTS node_dependencies (
  node_id TEXT NOT NULL REFERENCES workflow_nodes(id),
  depends_on_node_id TEXT NOT NULL REFERENCES workflow_nodes(id),
  PRIMARY KEY (node_id, depends_on_node_id),
  CHECK (node_id <> depends_on_node_id)
) STRICT;

CREATE TABLE IF NOT EXISTS human_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 20000),
  assigned_to TEXT CHECK (assigned_to IS NULL OR length(assigned_to) <= 200),
  status TEXT NOT NULL CHECK (status IN ('open','resolved','cancelled')),
  response TEXT CHECK (response IS NULL OR length(response) <= 20000),
  due_at_ms INTEGER,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  resolved_at_ms INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS seat_leases (
  id TEXT PRIMARY KEY,
  logical_seat TEXT NOT NULL REFERENCES roster_seats(logical_seat),
  project_id TEXT NOT NULL REFERENCES projects(id),
  node_id TEXT REFERENCES workflow_nodes(id),
  status TEXT NOT NULL CHECK (status IN ('active','released','expired')),
  acquired_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > acquired_at_ms),
  released_at_ms INTEGER,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS one_active_lease_per_seat
ON seat_leases(logical_seat) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS projects_queue_order ON projects(status, priority DESC, created_at_ms, id);
CREATE INDEX IF NOT EXISTS workflow_nodes_project_status ON workflow_nodes(project_id, status, created_at_ms);
CREATE INDEX IF NOT EXISTS node_dependencies_parent ON node_dependencies(depends_on_node_id, node_id);
CREATE INDEX IF NOT EXISTS human_requests_project_status ON human_requests(project_id, status, created_at_ms);
CREATE INDEX IF NOT EXISTS seat_leases_project_status ON seat_leases(project_id, status, acquired_at_ms);

CREATE TABLE IF NOT EXISTS harness_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  project_id TEXT,
  message TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS harness_events_project_seq ON harness_events(project_id, seq DESC);

CREATE TRIGGER IF NOT EXISTS control_state_no_update BEFORE UPDATE ON control_state
BEGIN SELECT RAISE(ABORT, 'compatibility control state is immutable and fail-closed'); END;
CREATE TRIGGER IF NOT EXISTS control_state_no_delete BEFORE DELETE ON control_state
BEGIN SELECT RAISE(ABORT, 'compatibility control state is immutable'); END;
CREATE TRIGGER IF NOT EXISTS shadow_meta_no_update BEFORE UPDATE ON shadow_meta
BEGIN SELECT RAISE(ABORT, 'shadow metadata is immutable'); END;
CREATE TRIGGER IF NOT EXISTS shadow_meta_no_delete BEFORE DELETE ON shadow_meta
BEGIN SELECT RAISE(ABORT, 'shadow metadata is immutable'); END;
CREATE TRIGGER IF NOT EXISTS roster_no_update BEFORE UPDATE ON roster_seats
BEGIN SELECT RAISE(ABORT, 'shadow roster is immutable'); END;
CREATE TRIGGER IF NOT EXISTS roster_no_delete BEFORE DELETE ON roster_seats
BEGIN SELECT RAISE(ABORT, 'shadow roster is immutable'); END;
CREATE TRIGGER IF NOT EXISTS project_slots_no_delete BEFORE DELETE ON project_slots
BEGIN SELECT RAISE(ABORT, 'project slots are durable'); END;
CREATE TRIGGER IF NOT EXISTS project_slot_owner_immutable BEFORE UPDATE OF slot_no, owner_logical_seat ON project_slots
BEGIN SELECT RAISE(ABORT, 'project slot identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON harness_events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON harness_events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TRIGGER IF NOT EXISTS project_transition_guard BEFORE UPDATE ON projects
BEGIN
  SELECT RAISE(ABORT, 'project identity and creation time are immutable')
  WHERE NEW.id <> OLD.id OR NEW.org <> OLD.org OR NEW.created_at_ms <> OLD.created_at_ms;
  SELECT RAISE(ABORT, 'project revision must advance exactly once')
  WHERE NEW.revision <> OLD.revision + 1 OR NEW.updated_at_ms < OLD.updated_at_ms;
  SELECT RAISE(ABORT, 'illegal project transition')
  WHERE NOT (
    NEW.status = OLD.status OR
    (OLD.status = 'queued' AND NEW.status IN ('admitted','cancelled')) OR
    (OLD.status = 'admitted' AND NEW.status IN ('paused','completed','cancelled')) OR
    (OLD.status = 'paused' AND NEW.status IN ('admitted','cancelled'))
  );
END;

CREATE TRIGGER IF NOT EXISTS node_transition_guard BEFORE UPDATE ON workflow_nodes
BEGIN
  SELECT RAISE(ABORT, 'node identity is immutable')
  WHERE NEW.id <> OLD.id OR NEW.project_id <> OLD.project_id OR NEW.created_at_ms <> OLD.created_at_ms;
  SELECT RAISE(ABORT, 'terminal workflow nodes are immutable')
  WHERE OLD.status IN ('completed','failed','cancelled');
  SELECT RAISE(ABORT, 'node revision must advance exactly once')
  WHERE NEW.revision <> OLD.revision + 1 OR NEW.updated_at_ms < OLD.updated_at_ms;
  SELECT RAISE(ABORT, 'a projected bus task binding is immutable')
  WHERE OLD.bus_task_id IS NOT NULL AND NEW.bus_task_id IS NOT OLD.bus_task_id;
  SELECT RAISE(ABORT, 'illegal node transition')
  WHERE NOT (
    NEW.status = OLD.status OR
    (OLD.status = 'pending' AND NEW.status IN ('ready','cancelled')) OR
    (OLD.status = 'ready' AND NEW.status IN ('dispatched','running','blocked','cancelled')) OR
    (OLD.status = 'dispatched' AND NEW.status IN ('running','completed','failed','blocked','cancelled')) OR
    (OLD.status = 'running' AND NEW.status IN ('completed','failed','blocked','cancelled')) OR
    (OLD.status = 'blocked' AND NEW.status IN ('ready','failed','cancelled'))
  );
END;

CREATE TRIGGER IF NOT EXISTS human_request_transition_guard BEFORE UPDATE ON human_requests
BEGIN
  SELECT RAISE(ABORT, 'human request identity is immutable')
  WHERE NEW.id <> OLD.id OR NEW.project_id <> OLD.project_id OR NEW.created_at_ms <> OLD.created_at_ms;
  SELECT RAISE(ABORT, 'human request revision must advance exactly once')
  WHERE NEW.revision <> OLD.revision + 1 OR NEW.updated_at_ms < OLD.updated_at_ms;
  SELECT RAISE(ABORT, 'illegal human request transition')
  WHERE NOT (OLD.status = 'open' AND NEW.status IN ('resolved','cancelled'));
END;

CREATE TRIGGER IF NOT EXISTS lease_transition_guard BEFORE UPDATE ON seat_leases
BEGIN
  SELECT RAISE(ABORT, 'lease authority fields are immutable')
  WHERE NEW.id <> OLD.id OR NEW.logical_seat <> OLD.logical_seat OR NEW.project_id <> OLD.project_id
     OR NEW.node_id IS NOT OLD.node_id OR NEW.acquired_at_ms <> OLD.acquired_at_ms;
  SELECT RAISE(ABORT, 'lease revision must advance exactly once') WHERE NEW.revision <> OLD.revision + 1;
  SELECT RAISE(ABORT, 'illegal lease transition')
  WHERE NOT (
    (OLD.status = 'active' AND NEW.status IN ('released','expired')) OR
    (OLD.status = 'active' AND NEW.status = 'active'
      AND NEW.expires_at_ms > OLD.expires_at_ms
      AND NEW.released_at_ms IS NULL)
  );
END;

CREATE TRIGGER IF NOT EXISTS project_created_event AFTER INSERT ON projects
BEGIN INSERT INTO harness_events(id,event_type,entity_type,entity_id,project_id,message,metadata_json,created_at_ms)
VALUES(lower(hex(randomblob(16))),'project.created','project',NEW.id,NEW.id,'Project submitted to compatibility queue',json_object('status',NEW.status),NEW.created_at_ms); END;
CREATE TRIGGER IF NOT EXISTS project_transition_event AFTER UPDATE ON projects
BEGIN INSERT INTO harness_events(id,event_type,entity_type,entity_id,project_id,message,metadata_json,created_at_ms)
VALUES(lower(hex(randomblob(16))),'project.transitioned','project',NEW.id,NEW.id,'Project state changed',json_object('from',OLD.status,'to',NEW.status,'revision',NEW.revision),NEW.updated_at_ms); END;
CREATE TRIGGER IF NOT EXISTS node_created_event AFTER INSERT ON workflow_nodes
BEGIN INSERT INTO harness_events(id,event_type,entity_type,entity_id,project_id,message,metadata_json,created_at_ms)
VALUES(lower(hex(randomblob(16))),'node.created','workflow_node',NEW.id,NEW.project_id,'Workflow node created',json_object('status',NEW.status),NEW.created_at_ms); END;
CREATE TRIGGER IF NOT EXISTS node_transition_event AFTER UPDATE ON workflow_nodes
BEGIN INSERT INTO harness_events(id,event_type,entity_type,entity_id,project_id,message,metadata_json,created_at_ms)
VALUES(lower(hex(randomblob(16))),'node.transitioned','workflow_node',NEW.id,NEW.project_id,'Workflow node state changed',json_object('from',OLD.status,'to',NEW.status,'revision',NEW.revision),NEW.updated_at_ms); END;
CREATE TRIGGER IF NOT EXISTS human_created_event AFTER INSERT ON human_requests
BEGIN INSERT INTO harness_events(id,event_type,entity_type,entity_id,project_id,message,metadata_json,created_at_ms)
VALUES(lower(hex(randomblob(16))),'human_request.created','human_request',NEW.id,NEW.project_id,'Human request created',json_object('status',NEW.status),NEW.created_at_ms); END;
CREATE TRIGGER IF NOT EXISTS human_transition_event AFTER UPDATE ON human_requests
BEGIN INSERT INTO harness_events(id,event_type,entity_type,entity_id,project_id,message,metadata_json,created_at_ms)
VALUES(lower(hex(randomblob(16))),'human_request.transitioned','human_request',NEW.id,NEW.project_id,'Human request state changed',json_object('from',OLD.status,'to',NEW.status),NEW.updated_at_ms); END;
CREATE TRIGGER IF NOT EXISTS lease_created_event AFTER INSERT ON seat_leases
BEGIN INSERT INTO harness_events(id,event_type,entity_type,entity_id,project_id,message,metadata_json,created_at_ms)
VALUES(lower(hex(randomblob(16))),'seat_lease.acquired','seat_lease',NEW.id,NEW.project_id,'Compatibility seat lease acquired',json_object('seat',NEW.logical_seat),NEW.acquired_at_ms); END;
CREATE TRIGGER IF NOT EXISTS lease_transition_event AFTER UPDATE ON seat_leases
BEGIN INSERT INTO harness_events(id,event_type,entity_type,entity_id,project_id,message,metadata_json,created_at_ms)
VALUES(lower(hex(randomblob(16))),'seat_lease.transitioned','seat_lease',NEW.id,NEW.project_id,'Compatibility seat lease state changed',json_object('from',OLD.status,'to',NEW.status,'seat',NEW.logical_seat),
  CASE WHEN NEW.status='active'
    THEN CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    ELSE COALESCE(NEW.released_at_ms,NEW.expires_at_ms)
  END); END;
`;
