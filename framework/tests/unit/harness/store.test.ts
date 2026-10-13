import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HarnessStore } from '../../../src/harness/store.js';
import { sanitizeProjectionValue } from '../../../src/harness/projector.js';
import { SHADOW_SCHEMA_SQL } from '../../../src/harness/schema.js';

const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
const describeNode26 = nodeMajor >= 26 ? describe : describe.skip;

describeNode26('HarnessStore compatibility shadow', () => {
  let tempRoot: string;
  let dbPath: string;
  let store: HarnessStore;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'cortex-harness-store-'));
    dbPath = join(tempRoot, 'harness', 'shadow-v1.db');
    store = HarnessStore.open(dbPath);
  });

  afterEach(() => {
    vi.useRealTimers();
    store.close();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function submit(id: string, org = 'atrium') {
    return store.submitProject({ id, org, title: `Project ${id}`, priority: 50 });
  }

  function admit(id: string, org = 'atrium') {
    submit(id, org);
    return store.admitProject(id);
  }

  function completeNode(projectId: string, id = `${projectId}-node`) {
    const node = store.createNode({
      id,
      projectId,
      nodeKey: id,
      name: `Node ${id}`,
      kind: 'build',
      requiredPool: 'sonnet',
      assignedSeat: 'c1',
    });
    store.updateNode(node.id, { status: 'running' });
    return store.updateNode(node.id, { status: 'completed', outputSummary: 'verified' });
  }

  it('is unmistakably non-authoritative and initializes immutable fail-closed controls', () => {
    const status = store.getStatus();

    expect(status.mode).toBe('compatibility-shadow');
    expect(status.productionAuthoritative).toBe(false);
    expect(status.control).toMatchObject({
      mode: 'compatibility-shadow',
      productionAuthoritative: false,
      dispatchEnabled: false,
      provisioningEnabled: false,
      providerCallsEnabled: false,
      spendingEnabled: false,
      canonicalGitMutationEnabled: false,
      externalEgressEnabled: false,
      schemaVersion: 1,
    });
    expect(status.slots).toHaveLength(4);
    expect(status.slots.map((slot) => slot.ownerLogicalSeat)).toEqual(['f1', 'f2', 'f3', 'f4']);
    expect(status.slots.every((slot) => slot.generation === 0 && slot.currentProjectId === null)).toBe(true);
    expect(() => new HarnessStore(join(tempRoot, 'harness.db'))).toThrow(/shadow-v1\.db/);

    store.close();
    const db = new DatabaseSync(dbPath);
    try {
      expect(() => db.prepare(
        'UPDATE control_state SET dispatch_enabled=1 WHERE singleton=1',
      ).run()).toThrow();
      expect(() => db.prepare(
        "UPDATE roster_seats SET enabled=1 WHERE logical_seat='c1'",
      ).run()).toThrow();
    } finally {
      db.close();
    }
    store = HarnessStore.open(dbPath);
  });

  it('seeds exactly the requested 16 disabled logical-to-physical seats', () => {
    const roster = store.listRoster();

    expect(roster).toHaveLength(16);
    expect(roster.map(({ logicalSeat, physicalAgent }) => [logicalSeat, physicalAgent])).toEqual([
      ['f0', 'rick'],
      ['f1', 'f1'],
      ['f2', 'f2'],
      ['f3', 'f3'],
      ['f4', 'f4'],
      ['c1', 'c1'],
      ['c2', 'c2'],
      ['c3', 'c3'],
      ['c4', 'c4'],
      ['c5', 'c5'],
      ['c6', 'c6'],
      ['c7', 'c7'],
      ['c8', 'c8'],
      ['o1', 'o1'],
      ['o2', 'o2'],
      ['o3', 'o3'],
    ]);
    expect(roster.every((seat) => seat.enabled === false && seat.desiredProfile === 'ultra')).toBe(true);
    expect(roster.filter((seat) => seat.pool === 'fable')).toHaveLength(5);
    expect(roster.filter((seat) => seat.pool === 'sonnet')).toHaveLength(8);
    expect(roster.filter((seat) => seat.pool === 'opus')).toHaveLength(3);
  });

  it('refuses Codex runtimes and GPT models on roster rows at the schema level', () => {
    const raw = new DatabaseSync(':memory:');
    try {
      raw.exec(SHADOW_SCHEMA_SQL);
      const insert = (pool: string, runtime: string, model: string, agent: string) => raw
        .prepare('INSERT INTO roster_seats (logical_seat,pool,role,desired_runtime,desired_model,desired_profile,physical_agent,enabled) VALUES (?,?,?,?,?,?,?,0)')
        .run(`x-${agent}`, pool, 'research-build-test', runtime, model, 'ultra', agent);
      expect(() => insert('sonnet', 'codex-app-server', 'sonnet-5.5', 'a1')).toThrow(/CHECK constraint failed/);
      expect(() => insert('sonnet', 'claude-code', 'gpt-5.6-sol', 'a2')).toThrow(/CHECK constraint failed/);
      expect(() => insert('codex', 'claude-code', 'sonnet-5.5', 'a3')).toThrow(/CHECK constraint failed/);
      expect(() => insert('sonnet', 'claude-code', 'sonnet-5.5', 'a4')).not.toThrow();
    } finally {
      raw.close();
    }
  });

  it('admits no more than four projects and leaves the fifth durably queued', () => {
    for (let index = 1; index <= 5; index += 1) submit(`p${index}`);
    for (let index = 1; index <= 4; index += 1) store.admitProject(`p${index}`);

    expect(() => store.admitProject('p5')).toThrow(/four projects are already admitted/i);
    expect(store.getStatus()).toMatchObject({ activeProjectCount: 4, queuedProjectCount: 1 });
    expect(store.getProject('p5')).toMatchObject({ status: 'queued', slotNo: null, slotGeneration: null });
    expect(store.listProjectSlots().map((slot) => slot.currentProjectId)).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  it('clears stale slot bindings and advances generation on every reuse', () => {
    expect(admit('alpha')).toMatchObject({ slotNo: 1, slotGeneration: 1 });

    expect(store.pauseProject('alpha')).toMatchObject({
      status: 'paused',
      slotNo: null,
      slotGeneration: null,
    });
    expect(store.listProjectSlots()[0]).toMatchObject({ generation: 1, currentProjectId: null });

    expect(admit('beta')).toMatchObject({ slotNo: 1, slotGeneration: 2 });
    expect(store.cancelProject('beta', 'superseded')).toMatchObject({
      status: 'cancelled',
      slotNo: null,
      slotGeneration: null,
    });

    expect(store.resumeProject('alpha')).toMatchObject({ slotNo: 1, slotGeneration: 3 });
    completeNode('alpha');
    expect(store.completeProject('alpha')).toMatchObject({
      status: 'completed',
      slotNo: null,
      slotGeneration: null,
    });
    expect(store.listProjectSlots()[0]).toMatchObject({ generation: 3, currentProjectId: null });
  });

  it('rejects illegal project transitions and requires real completed work', () => {
    submit('queued');
    expect(() => store.pauseProject('queued')).toThrow(/cannot pause from queued/);
    expect(() => store.resumeProject('queued')).toThrow(/cannot resume from queued/);
    expect(() => store.completeProject('queued')).toThrow(/cannot complete from queued/);
    expect(store.cancelProject('queued').status).toBe('cancelled');
    expect(() => store.cancelProject('queued')).toThrow(/cannot cancel from cancelled/);

    admit('active');
    expect(() => store.completeProject('active')).toThrow(/at least one workflow node/i);
    completeNode('active');
    const request = store.createHumanRequest({
      projectId: 'active',
      title: 'Choose release name',
      description: 'Human decision is required',
    });
    expect(() => store.completeProject('active')).toThrow(/open human requests/);
    store.resolveHumanRequest(request.id, { response: 'Use the internal codename' });
    expect(store.completeProject('active').status).toBe('completed');
  });

  it('holds dependent nodes pending until all dependencies complete', () => {
    admit('deps');
    const parent = store.createNode({
      id: 'parent', projectId: 'deps', nodeKey: 'parent', name: 'Parent', kind: 'plan', requiredPool: 'fable',
    });
    const child = store.createNode({
      id: 'child', projectId: 'deps', nodeKey: 'child', name: 'Child', kind: 'build',
      requiredPool: 'sonnet', dependsOn: [parent.id],
    });

    expect(parent.status).toBe('ready');
    expect(child).toMatchObject({ status: 'pending', dependsOn: ['parent'] });
    expect(() => store.updateNode(child.id, { status: 'ready' })).toThrow(/every dependency/);
    store.updateNode(parent.id, { status: 'running' });
    store.updateNode(parent.id, { status: 'completed' });
    expect(store.listNodes('deps').find((node) => node.id === child.id)?.status).toBe('ready');

    expect(() => store.createNode({
      projectId: 'deps', nodeKey: 'cross', name: 'Cross', kind: 'build', dependsOn: ['missing'],
    })).toThrow(/not found/);
  });

  it('makes terminal nodes immutable and bus projection idempotent across restart', () => {
    admit('bus');
    const first = store.createNode({
      id: 'bus-one', projectId: 'bus', nodeKey: 'one', name: 'One', kind: 'build', requiredPool: 'sonnet',
    });
    const second = store.createNode({
      id: 'bus-two', projectId: 'bus', nodeKey: 'two', name: 'Two', kind: 'build', requiredPool: 'sonnet',
    });

    expect(() => store.updateNode(first.id, {
      status: 'ready', busTaskId: 'task-too-early',
    })).toThrow(/only while projecting.*dispatched/i);
    expect(store.updateNode(first.id, {
      status: 'dispatched', busTaskId: 'task-durable-001',
    })).toMatchObject({ status: 'dispatched', busTaskId: 'task-durable-001' });

    store.close();
    store = HarnessStore.open(dbPath);
    expect(store.listNodes('bus').find((node) => node.id === first.id)).toMatchObject({
      status: 'dispatched',
      busTaskId: 'task-durable-001',
    });
    expect(() => store.updateNode(second.id, {
      status: 'dispatched', busTaskId: 'task-durable-001',
    })).toThrow();
    expect(store.listNodes('bus').find((node) => node.id === second.id)?.status).toBe('ready');
    expect(() => store.updateNode(first.id, {
      status: 'running', busTaskId: 'task-different',
    })).toThrow(/immutable/);

    store.updateNode(first.id, { status: 'running' });
    const completed = store.updateNode(first.id, { status: 'completed' });
    expect(completed.busTaskId).toBe('task-durable-001');
    expect(() => store.updateNode(first.id, { status: 'completed' })).toThrow(/terminal/);
  });

  it('enforces exclusive expiring seat leases and blocks parking while leased', () => {
    admit('leased');
    const assigned = store.createNode({
      id: 'lease-assigned-node',
      projectId: 'leased',
      nodeKey: 'lease-assigned-node',
      name: 'Lease assigned node',
      requiredPool: 'sonnet',
      assignedSeat: 'c1',
    });
    expect(() => store.acquireLease({
      logicalSeat: 'c2', projectId: 'leased', nodeId: assigned.id,
    })).toThrow(/does not match node assignment/);
    const future = Date.now() + 60_000;
    vi.useFakeTimers({ now: future });

    const first = store.acquireLease({
      id: 'lease-one', logicalSeat: 'c1', projectId: 'leased', ttlMs: 1_000,
    });
    expect(first.status).toBe('active');
    expect(() => store.acquireLease({
      logicalSeat: 'c1', projectId: 'leased', ttlMs: 1_000,
    })).toThrow(/already has an active lease/);
    expect(() => store.pauseProject('leased')).toThrow(/active seat leases/);

    vi.advanceTimersByTime(500);
    const renewed = store.renewLease(first.id, 2_000);
    expect(renewed.revision).toBe(first.revision + 1);
    expect(renewed.expiresAtMs).toBeGreaterThan(first.expiresAtMs);
    vi.advanceTimersByTime(600);
    expect(store.listLeases({ status: 'active' }).map((lease) => lease.id)).toContain(first.id);

    expect(store.releaseLease(first.id).status).toBe('released');
    const second = store.acquireLease({
      id: 'lease-two', logicalSeat: 'c1', projectId: 'leased', ttlMs: 1_000,
    });
    vi.advanceTimersByTime(1_001);
    expect(store.listLeases({ status: 'expired' }).map((lease) => lease.id)).toContain(second.id);
    expect(store.pauseProject('leased').status).toBe('paused');
  });

  it('resolves human requests once and cancels project-owned work atomically', () => {
    admit('cancel-all');
    const node = store.createNode({
      id: 'cancel-node', projectId: 'cancel-all', nodeKey: 'node', name: 'Node', kind: 'build',
    });
    const request = store.createHumanRequest({ projectId: 'cancel-all', title: 'Need input' });
    store.acquireLease({ id: 'cancel-lease', logicalSeat: 'c1', projectId: 'cancel-all' });

    expect(store.cancelProject('cancel-all', 'operator stopped it').status).toBe('cancelled');
    expect(store.listNodes('cancel-all').find((item) => item.id === node.id)?.status).toBe('cancelled');
    expect(store.listHumanRequests('cancel-all').find((item) => item.id === request.id)?.status).toBe('cancelled');
    expect(store.listLeases({ projectId: 'cancel-all' })[0]?.status).toBe('released');
    expect(store.listProjectSlots()[0]?.currentProjectId).toBeNull();
    expect(() => store.resolveHumanRequest(request.id, 'too late')).toThrow(/already cancelled/);
  });

  it('emits a sanitized dashboard snapshot without private work payloads', () => {
    store.submitProject({
      id: 'private',
      org: 'atrium',
      title: 'Visible title',
      description: 'PROJECT_DESCRIPTION_MUST_NOT_PROJECT',
    });
    store.admitProject('private');
    const node = store.createNode({
      id: 'private-node',
      projectId: 'private',
      nodeKey: 'private-node',
      name: 'Visible node',
      kind: 'build',
      inputSummary: 'NODE_INPUT_MUST_NOT_PROJECT',
    });
    store.updateNode(node.id, { status: 'running', outputSummary: 'NODE_OUTPUT_MUST_NOT_PROJECT' });
    const request = store.createHumanRequest({
      id: 'private-human',
      projectId: 'private',
      title: 'Visible request',
      description: 'HUMAN_DESCRIPTION_MUST_NOT_PROJECT',
    });
    store.resolveHumanRequest(request.id, 'HUMAN_RESPONSE_MUST_NOT_PROJECT');

    const snapshot = store.getProjectionSnapshot();
    const serialized = JSON.stringify(snapshot);
    expect(snapshot).toMatchObject({ mode: 'compatibility-shadow', productionAuthoritative: false });
    expect(snapshot.projects[0]).toMatchObject({ id: 'private', org: 'atrium', title: 'Visible title' });
    expect(snapshot.recentEvents.every((event) => !('metadata' in event))).toBe(true);
    expect(serialized).not.toContain('PROJECT_DESCRIPTION_MUST_NOT_PROJECT');
    expect(serialized).not.toContain('NODE_INPUT_MUST_NOT_PROJECT');
    expect(serialized).not.toContain('NODE_OUTPUT_MUST_NOT_PROJECT');
    expect(serialized).not.toContain('HUMAN_DESCRIPTION_MUST_NOT_PROJECT');
    expect(serialized).not.toContain('HUMAN_RESPONSE_MUST_NOT_PROJECT');
    expect(serialized).not.toContain(dbPath);
  });

  it('removes private projection keys in snake, kebab, and camel case', () => {
    expect(sanitizeProjectionValue({
      databasePath: '/private/control.db',
      authToken: 'private-auth',
      source_file: '/private/source',
      'credential-key': 'private-key',
      safeState: 'visible',
      nested: { privatePrompt: 'hidden', projectId: 'project-safe' },
    })).toEqual({
      nested: { projectId: 'project-safe' },
      safeState: 'visible',
    });
  });

  it('validates orgs and retains durable state with private filesystem modes', () => {
    expect(() => store.submitProject({
      id: 'bad-org', org: '../Atrium', title: 'Bad',
    })).toThrow(/org must contain only lowercase/);
    const project = admit('persistent', 'cortex_os');
    const request = store.createHumanRequest({
      id: 'persistent-human', projectId: project.id, title: 'Persist me',
    });
    store.acquireLease({
      id: 'persistent-lease', logicalSeat: 'o1', projectId: project.id, ttlMs: 60_000,
    });
    store.close();

    expect(statSync(join(tempRoot, 'harness')).mode & 0o777).toBe(0o700);
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);

    store = HarnessStore.open(dbPath);
    expect(store.getProject(project.id)).toMatchObject({
      id: 'persistent', org: 'cortex_os', status: 'admitted', slotNo: 1, slotGeneration: 1,
    });
    expect(store.listHumanRequests(project.id).map((item) => item.id)).toContain(request.id);
    expect(store.listLeases({ projectId: project.id })[0]).toMatchObject({
      id: 'persistent-lease', status: 'active', logicalSeat: 'o1',
    });
    expect(store.listEvents(100, project.id).length).toBeGreaterThanOrEqual(3);
  });
});
