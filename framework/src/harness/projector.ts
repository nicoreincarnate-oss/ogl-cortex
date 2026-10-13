import { chmodSync, existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';

const MAX_PROJECTION_DEPTH = 12;
const MAX_PROJECTED_STRING_LENGTH = 32_768;

// Projection output is intentionally narrower than the authoritative shadow
// store. These names cover credentials as well as implementation details that
// would let a dashboard process locate or mutate the control store directly.
const FORBIDDEN_KEY = /(?:^|_)(?:argv|auth|canonical_json|credential|database|db_path|environment|home|key|password|private|prompt|raw|secret|signature|socket|source_file|token)(?:$|_)/i;

function projectionKeyIsForbidden(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-z0-9]+/gi, '_')
    .toLowerCase();
  return FORBIDDEN_KEY.test(normalized);
}

export interface ShadowProjectionControl {
  dispatch_enabled: false;
  egress_enabled: false;
  spend_enabled: false;
  provisioning_enabled: false;
  compatibility_bus_projection_enabled: boolean;
}

export interface ShadowProjectionEnvelope {
  schema_id: 'cortex-harness-shadow-projection/v1';
  schema_version: 1;
  projection_sequence: number;
  mode: 'shadow';
  generated_at_ms: number;
  control: ShadowProjectionControl;
  preflight: unknown;
  snapshot: unknown;
}

export interface ProjectionSnapshotSource {
  getProjectionSnapshot(): unknown;
}

/**
 * Recursively copy a value into the dashboard projection trust domain.
 *
 * The shadow store should already return a projection-safe DTO, but this
 * second boundary is deliberate: newly-added store columns do not become
 * dashboard-readable merely because a developer included them in a generic
 * SELECT. Object keys are sorted to keep output deterministic between ticks.
 */
export function sanitizeProjectionValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_PROJECTION_DEPTH) return '[depth-limit]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, MAX_PROJECTED_STRING_LENGTH);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeProjectionValue(item, depth + 1));
  }
  if (typeof value !== 'object') return String(value).slice(0, MAX_PROJECTED_STRING_LENGTH);

  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort()) {
    if (projectionKeyIsForbidden(key)) continue;
    output[key] = sanitizeProjectionValue(input[key], depth + 1);
  }
  return output;
}

export class HarnessProjector {
  readonly projectionPath: string;
  private projectionSequence = 0;

  constructor(ctxRoot: string, projectionPath = join(ctxRoot, 'harness', 'projection.json')) {
    this.projectionPath = projectionPath;
    if (existsSync(projectionPath)) {
      try {
        const existing = JSON.parse(readFileSync(projectionPath, 'utf-8')) as {
          projection_sequence?: unknown;
        };
        if (typeof existing.projection_sequence === 'number'
          && Number.isSafeInteger(existing.projection_sequence)
          && existing.projection_sequence >= 0) {
          this.projectionSequence = existing.projection_sequence;
        }
      } catch {
        // A corrupt projection is disposable. The next write rebuilds it from
        // the store and starts a fresh local sequence.
      }
    }
  }

  write(
    source: ProjectionSnapshotSource,
    control: ShadowProjectionControl,
    preflight: unknown,
    nowMs = Date.now(),
  ): ShadowProjectionEnvelope {
    this.projectionSequence += 1;
    const envelope: ShadowProjectionEnvelope = {
      schema_id: 'cortex-harness-shadow-projection/v1',
      schema_version: 1,
      projection_sequence: this.projectionSequence,
      mode: 'shadow',
      generated_at_ms: nowMs,
      control,
      preflight: sanitizeProjectionValue(preflight),
      snapshot: sanitizeProjectionValue(source.getProjectionSnapshot()),
    };

    ensureDir(dirname(this.projectionPath));
    atomicWriteSync(this.projectionPath, JSON.stringify(envelope, null, 2));
    try {
      chmodSync(this.projectionPath, 0o600);
    } catch {
      // Windows and unusual filesystems may not implement POSIX modes.
    }
    return envelope;
  }
}
