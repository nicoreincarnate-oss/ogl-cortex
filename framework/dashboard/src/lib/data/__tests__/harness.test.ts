import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  HARNESS_LEGACY_PROJECTION_SCHEMA,
  HARNESS_PROJECTION_MAX_AGE_MS,
  HARNESS_PROJECTION_MAX_BYTES,
  readHarnessProjection,
  sanitizeHarnessProjection,
} from '../harness';

const tempDirs: string[] = [];
const NOW_MS = 1_789_000_000_000;

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-projection-'));
  tempDirs.push(dir);
  return dir;
}

function writeProjection(value: unknown): string {
  const dir = makeTempDir();
  const file = path.join(dir, 'projection.json');
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('readHarnessProjection', () => {
  it('fails closed when the projection has not been generated', () => {
    const snapshot = readHarnessProjection(
      path.join(makeTempDir(), 'missing.json'),
    );

    expect(snapshot).toMatchObject({
      available: false,
      state: 'missing',
      dispatchEnabled: false,
      liveProjects: 0,
      maxLiveProjects: 4,
      projects: [],
    });
  });

  it('normalizes snake-case fields into a bounded, projection-only DTO', () => {
    const file = writeProjection({
      schema_version: 'cortex-harness-projection-v1',
      generated_at: new Date(NOW_MS).toISOString(),
      projection_sequence: 42,
      mode: 'active',
      dispatch_enabled: true,
      admission_mode: 'open',
      max_live_projects: 4,
      live_projects: 1,
      queued_projects: 1,
      control_db_path: '/private/harness.db',
      api_token: 'do-not-leak',
      seat_summary: {
        total: 16,
        available: 10,
        leased: 2,
        running: 4,
        quarantined: 0,
      },
      projects: [
        {
          project_id: 'project-1',
          project_name: 'Launch Cortex',
          org_id: 'atrium',
          status: 'in_progress',
          project_slot: 'slot-1',
          current_phase: 'implementation',
          current_node: 'build-dashboard',
          progress_percent: 55,
          planner_seat: 'fable-planner-1',
          node_counts: {
            ready: 2,
            running: 3,
            completed: 5,
            failed: 0,
          },
          budget_summary: {
            spent_micro_usd: 1_250_000,
            reserved_micro_usd: 250_000,
            hard_cap_micro_usd: 5_000_000,
          },
          pending_human_requests: 1,
          pending_approvals: 2,
          raw_prompt: 'private user prompt',
          workspace_path: '/private/worktree',
        },
      ],
    });

    const snapshot = readHarnessProjection(file, NOW_MS);

    expect(snapshot).toMatchObject({
      available: true,
      state: 'ready',
      sequence: 42,
      mode: 'active',
      dispatchEnabled: true,
      admissionMode: 'open',
      maxLiveProjects: 4,
      liveProjects: 1,
      queuedProjects: 1,
      seatSummary: { total: 16, available: 10, leased: 2, running: 4 },
    });
    expect(snapshot.projects[0]).toMatchObject({
      id: 'project-1',
      name: 'Launch Cortex',
      org: 'atrium',
      status: 'active',
      slot: 1,
      phase: 'implementation',
      currentNode: 'build-dashboard',
      progress: 55,
      plannerSeat: 'fable-planner-1',
      counts: { pending: 0, ready: 2, running: 3, completed: 5, total: 10 },
      budget: {
        spentMicroUsd: 1_250_000,
        reservedMicroUsd: 250_000,
        hardCapMicroUsd: 5_000_000,
        currency: 'USD',
      },
      humanRequestsPending: 1,
      approvalsPending: 2,
    });

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('harness.db');
    expect(serialized).not.toContain('do-not-leak');
    expect(serialized).not.toContain('private user prompt');
    expect(serialized).not.toContain('/private/worktree');
  });

  it('makes the kill switch authoritative over dispatch state', () => {
    const snapshot = readHarnessProjection(
      writeProjection({
        schema_version: HARNESS_LEGACY_PROJECTION_SCHEMA,
        generated_at_ms: NOW_MS,
        projection_sequence: 1,
        dispatch_enabled: true,
        kill_switch: true,
      }),
      NOW_MS,
    );

    expect(snapshot.killSwitch).toBe(true);
    expect(snapshot.dispatchEnabled).toBe(false);
  });

  it('reads the HarnessProjector envelope and keeps control authoritative', () => {
    const snapshot = readHarnessProjection(
      writeProjection({
        schema_id: 'cortex-harness-shadow-projection/v1',
        schema_version: 1,
        projection_sequence: 7,
        mode: 'shadow',
        generated_at_ms: 1_789_000_000_000,
        control: {
          dispatch_enabled: false,
          egress_enabled: false,
          spend_enabled: false,
          provisioning_enabled: false,
          compatibility_bus_projection_enabled: true,
        },
        preflight: {
          mode: 'compatibility-shadow',
          supported: true,
          readiness_scope: 'compatibility-bus-projection',
          shadow_base_usable: true,
          node: { actual_major: 26, minimum_major: 22, satisfied: true },
          disk: { available_bytes: 1, minimum_bytes: 2, satisfied: false },
          compatibility_bus_projection: {
            requested: true,
            effective: false,
            refusal_reasons: ['free-space-below-minimum'],
          },
          private_diagnostic_path: '/do/not/expose',
        },
        snapshot: {
          mode: 'compatibility-shadow',
          productionAuthoritative: false,
          generatedAtMs: 1_789_000_000_000,
          control: {
            mode: 'compatibility-shadow',
            productionAuthoritative: false,
            dispatchEnabled: false,
            provisioningEnabled: false,
            providerCallsEnabled: false,
            spendingEnabled: false,
            canonicalGitMutationEnabled: false,
            externalEgressEnabled: false,
            schemaVersion: 1,
            initializedAtMs: 1_788_999_000_000,
          },
          slots: [
            {
              slotNo: 1,
              ownerLogicalSeat: 'f1',
              generation: 4,
              currentProjectId: 'enveloped-live',
              updatedAtMs: 1_789_000_000_000,
            },
          ],
          projects: [
            {
              id: 'enveloped-live',
              title: 'Enveloped Live Project',
              priority: 100,
              status: 'admitted',
              slotNo: 1,
              slotGeneration: 4,
              revision: 3,
              createdAtMs: 1_788_000_000_000,
              updatedAtMs: 1_789_000_000_000,
            },
            {
              id: 'enveloped-queue',
              title: 'Enveloped Queued Project',
              priority: 50,
              status: 'queued',
              slotNo: null,
              slotGeneration: null,
              revision: 1,
              createdAtMs: 1_788_100_000_000,
              updatedAtMs: 1_788_100_000_000,
            },
          ],
          roster: [
            'f0', 'f1', 'f2', 'f3', 'f4',
            'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8',
            'o1', 'o2', 'o3',
          ].map((logicalSeat) => ({
            logicalSeat,
            pool: logicalSeat.startsWith('f')
              ? 'fable'
              : logicalSeat.startsWith('c')
                ? 'codex'
                : 'opus',
            role: 'test-seat',
            desiredRuntime: 'codex-app-server',
            desiredModel: 'gpt-5.6-sol',
            desiredProfile: 'ultra',
            physicalAgent: `${logicalSeat}-agent`,
            enabled: false,
          })),
          nodes: [
            {
              id: 'node-plan',
              projectId: 'enveloped-live',
              name: 'Plan',
              kind: 'planning',
              assignedSeat: 'f1',
              status: 'completed',
            },
            {
              id: 'node-build',
              projectId: 'enveloped-live',
              name: 'Build',
              kind: 'build',
              assignedSeat: 'c1',
              status: 'dispatched',
            },
            {
              id: 'node-review',
              projectId: 'enveloped-live',
              name: 'Review',
              kind: 'review',
              assignedSeat: null,
              status: 'pending',
            },
          ],
          humanRequests: [
            {
              id: 'human-open',
              projectId: 'enveloped-live',
              title: 'Confirm deployment window',
              description: 'must never reach the dashboard DTO',
              assignedTo: 'nico',
              status: 'open',
              dueAtMs: 1_789_100_000_000,
              updatedAtMs: 1_789_000_000_000,
            },
            {
              id: 'human-done',
              projectId: 'enveloped-live',
              title: 'Choose the primary color',
              assignedTo: null,
              status: 'resolved',
              dueAtMs: null,
              updatedAtMs: 1_788_000_000_000,
            },
          ],
          leases: [
            {
              id: 'lease-builder',
              logicalSeat: 'c1',
              projectId: 'enveloped-live',
              nodeId: 'node-build',
              status: 'active',
              expiresAtMs: 1_789_200_000_000,
            },
            {
              id: 'lease-planner',
              logicalSeat: 'f1',
              projectId: 'enveloped-live',
              nodeId: null,
              status: 'active',
              expiresAtMs: 1_789_200_000_000,
            },
          ],
          recentEvents: [],
        },
      }),
      1_789_000_000_000,
    );

    expect(snapshot).toMatchObject({
      available: true,
      schemaVersion: 'cortex-harness-shadow-projection/v1',
      sequence: 7,
      mode: 'shadow',
      dispatchEnabled: false,
      preflightReady: false,
      preflightBlockers: 1,
      preflightScope: 'compatibility-bus-projection',
      shadowBaseUsable: true,
      compatibilityProjectionRequested: true,
      compatibilityProjectionEffective: false,
      liveProjects: 1,
      queuedProjects: 1,
      seatSummary: { total: 16, running: 1, available: 0, leased: 1 },
    });
    expect(snapshot.projects.map((project) => project.id)).toEqual([
      'enveloped-live',
      'enveloped-queue',
    ]);
    expect(snapshot.projects[0]).toMatchObject({
      name: 'Enveloped Live Project',
      status: 'admitted',
      slot: 1,
      generation: 4,
      phase: 'build',
      currentNode: 'Build',
      plannerSeat: 'f1',
      humanRequestsPending: 1,
      counts: {
        pending: 1,
        ready: 0,
        running: 1,
        blocked: 0,
        completed: 1,
        failed: 0,
        total: 3,
      },
    });
    expect(snapshot.humanRequests).toEqual([
      expect.objectContaining({
        id: 'human-open',
        projectId: 'enveloped-live',
        title: 'Confirm deployment window',
        assignedTo: 'nico',
        status: 'open',
        dueAtMs: 1_789_100_000_000,
      }),
      expect.objectContaining({ id: 'human-done', status: 'resolved' }),
    ]);
    expect(snapshot.seats).toHaveLength(16);
    expect(snapshot.seats.filter((seat) => seat.pool === 'fable')).toHaveLength(5);
    expect(snapshot.seats.filter((seat) => seat.pool === 'codex')).toHaveLength(8);
    expect(snapshot.seats.filter((seat) => seat.pool === 'opus')).toHaveLength(3);
    expect(snapshot.seats.find((seat) => seat.logicalSeat === 'f1')).toMatchObject({
      physicalAgent: 'f1-agent',
      enabled: false,
      state: 'leased',
      projectId: 'enveloped-live',
    });
    expect(snapshot.seats.find((seat) => seat.logicalSeat === 'c1')).toMatchObject({
      physicalAgent: 'c1-agent',
      enabled: false,
      state: 'running',
      nodeId: 'node-build',
    });
    expect(JSON.stringify(snapshot)).not.toContain('/do/not/expose');
    expect(JSON.stringify(snapshot)).not.toContain('must never reach');
  });

  it('rejects malformed, empty, oversized, and symlinked projections', () => {
    const dir = makeTempDir();
    const malformed = path.join(dir, 'malformed.json');
    fs.writeFileSync(malformed, '{not-json');
    expect(readHarnessProjection(malformed).state).toBe('invalid');

    const empty = path.join(dir, 'empty.json');
    fs.writeFileSync(empty, '');
    expect(readHarnessProjection(empty).state).toBe('invalid');

    const oversized = path.join(dir, 'oversized.json');
    fs.writeFileSync(oversized, Buffer.alloc(HARNESS_PROJECTION_MAX_BYTES + 1));
    expect(readHarnessProjection(oversized).state).toBe('invalid');

    const target = path.join(dir, 'target.json');
    const link = path.join(dir, 'link.json');
    fs.writeFileSync(target, '{}');
    fs.symlinkSync(target, link);
    expect(readHarnessProjection(link).state).toBe('invalid');
  });

  it('rejects missing/unknown schemas and marks old projections stale', () => {
    expect(readHarnessProjection(writeProjection({}), NOW_MS).state).toBe('invalid');
    expect(readHarnessProjection(writeProjection({
      schema_id: 'unknown-projection/v9',
      schema_version: 9,
      generated_at_ms: NOW_MS,
      projection_sequence: 1,
      control: {},
      snapshot: {},
    }), NOW_MS).state).toBe('invalid');

    const stale = readHarnessProjection(writeProjection({
      schema_version: HARNESS_LEGACY_PROJECTION_SCHEMA,
      generated_at_ms: NOW_MS - HARNESS_PROJECTION_MAX_AGE_MS - 1,
      projection_sequence: 2,
    }), NOW_MS);
    expect(stale).toMatchObject({ available: false, state: 'stale', dispatchEnabled: false });

    expect(readHarnessProjection(writeProjection({
      schema_version: HARNESS_LEGACY_PROJECTION_SCHEMA,
      generated_at_ms: Number.MAX_SAFE_INTEGER,
      projection_sequence: 3,
    }), NOW_MS).state).toBe('invalid');
  });
});

describe('sanitizeHarnessProjection', () => {
  it('collects slot and queue projections without exposing source objects', () => {
    const snapshot = sanitizeHarnessProjection({
      schema_version: HARNESS_LEGACY_PROJECTION_SCHEMA,
      generated_at_ms: NOW_MS,
      projection_sequence: 1,
      mode: 'shadow',
      slots: [
        {
          id: 'slot-2',
          project: { id: 'live-project', name: 'Live Project' },
        },
      ],
      queue: {
        items: [{ id: 'queued-project', name: 'Queued Project' }],
      },
    });

    expect(snapshot?.projects).toEqual([
      expect.objectContaining({
        id: 'live-project',
        slot: 2,
        status: 'active',
      }),
      expect.objectContaining({
        id: 'queued-project',
        slot: null,
        status: 'queued',
      }),
    ]);
    expect(snapshot?.liveProjects).toBe(1);
    expect(snapshot?.queuedProjects).toBe(1);
  });

  it('does not count paused projects as live and keeps pending distinct from ready', () => {
    const snapshot = sanitizeHarnessProjection({
      schema_version: HARNESS_LEGACY_PROJECTION_SCHEMA,
      generated_at_ms: NOW_MS,
      projection_sequence: 2,
      projects: [
        { id: 'live', name: 'Live', status: 'admitted' },
        { id: 'paused', name: 'Paused', status: 'paused' },
      ],
      nodes: [
        { id: 'future', projectId: 'live', name: 'Future', status: 'pending' },
        { id: 'runnable', projectId: 'live', name: 'Runnable', status: 'ready' },
      ],
    });

    expect(snapshot?.liveProjects).toBe(1);
    expect(snapshot?.projects.find((project) => project.id === 'live')?.counts).toMatchObject({
      pending: 1,
      ready: 1,
    });
    expect(snapshot?.projects.find((project) => project.id === 'live')?.currentNode).toBe('Runnable');
  });
});
