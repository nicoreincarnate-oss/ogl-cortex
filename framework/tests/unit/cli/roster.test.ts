import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadDeliveryRoster,
  planRosterApply,
  rosterCommand,
  validateDeliveryRoster,
} from '../../../src/cli/roster.js';

const REAL_MANIFEST = join(__dirname, '..', '..', '..', 'config', 'harness', 'roster.delivery.v21.json');

describe('literal disabled delivery roster', () => {
  let projectRoot: string;
  let homeRoot: string;
  let originalHome: string | undefined;
  let originalFrameworkRoot: string | undefined;
  let originalProjectRoot: string | undefined;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'cortex-roster-project-'));
    homeRoot = mkdtempSync(join(tmpdir(), 'cortex-roster-home-'));
    originalHome = process.env.HOME;
    originalFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
    originalProjectRoot = process.env.CTX_PROJECT_ROOT;
    process.env.HOME = homeRoot;
    process.env.CTX_FRAMEWORK_ROOT = projectRoot;
    process.env.CTX_PROJECT_ROOT = projectRoot;

    mkdirSync(join(projectRoot, 'orgs', 'atrium', 'agents', 'rick'), { recursive: true });
    writeFileSync(join(projectRoot, 'orgs', 'atrium', 'agents', 'rick', 'config.json'), JSON.stringify({
      agent_name: 'rick', enabled: true, runtime: 'claude-code', model: 'claude-fable-5[1m]',
    }, null, 2));
    symlinkSync(join(__dirname, '..', '..', '..', 'templates'), join(projectRoot, 'templates'), 'dir');

    const registryPath = join(homeRoot, '.cortextos', 'cortextos1', 'config', 'enabled-agents.json');
    mkdirSync(join(registryPath, '..'), { recursive: true });
    writeFileSync(registryPath, JSON.stringify({ rick: { enabled: true, org: 'atrium' } }, null, 2) + '\n');
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    process.env.CTX_FRAMEWORK_ROOT = originalFrameworkRoot;
    process.env.CTX_PROJECT_ROOT = originalProjectRoot;
    vi.restoreAllMocks();
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(homeRoot, { recursive: true, force: true });
  });

  it('validates the exact 5/8/3 literal topology and requested/resolved model mapping', () => {
    const manifest = loadDeliveryRoster(REAL_MANIFEST);
    expect(manifest.seats).toHaveLength(16);
    expect(manifest.seats.map(seat => seat.identity)).toEqual([
      'rick', 'f1', 'f2', 'f3', 'f4', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'o1', 'o2', 'o3',
    ]);
    expect(manifest.seats.find(seat => seat.seat === 'F1')).toMatchObject({
      requestedModel: 'fable-5', requestedProfile: 'ultra', resolvedModel: 'claude-fable-5[1m]', resolvedEffort: 'max',
    });
    expect(manifest.seats.find(seat => seat.seat === 'C1')).toMatchObject({
      requestedModel: 'sonnet-5.5', requestedProfile: 'ultra', resolvedModel: 'claude-sonnet-5-5', resolvedEffort: 'ultra',
    });
    expect(manifest.seats.find(seat => seat.seat === 'O3')).toMatchObject({
      requestedModel: 'opus-4.8', requestedProfile: 'ultra', resolvedModel: 'claude-opus-4-8[1m]', resolvedEffort: 'max',
    });
  });

  it('rejects compatibility mappings, duplicate identities, enablement, and unresolved tokens', () => {
    const base = JSON.parse(readFileSync(REAL_MANIFEST, 'utf-8'));
    const compatibility = structuredClone(base);
    compatibility.seats[1].compatibilityHostIdentity = 'beth';
    expect(validateDeliveryRoster(compatibility).errors.join('\n')).toMatch(/compatibility|unknown field/i);

    const duplicate = structuredClone(base);
    duplicate.seats[2].identity = 'f1';
    expect(validateDeliveryRoster(duplicate).errors.join('\n')).toMatch(/duplicate physical identity/);

    const enabled = structuredClone(base);
    enabled.seats[5].enabled = true;
    expect(validateDeliveryRoster(enabled).errors.join('\n')).toMatch(/enabled must be false/);

    const unresolved = structuredClone(base);
    unresolved.seats[5].resolvedModel = 'RESOLVE_CODEX_MODEL';
    expect(validateDeliveryRoster(unresolved).errors.join('\n')).toMatch(/unresolved token/);
  });

  it('dry-runs by default and creates nothing', async () => {
    await rosterCommand.parseAsync([
      'node', 'cli', 'apply', REAL_MANIFEST, '--disabled-only', '--json',
    ]);
    expect(existsSync(join(projectRoot, 'orgs', 'atrium', 'agents', 'f1'))).toBe(false);
    const registry = JSON.parse(readFileSync(
      join(homeRoot, '.cortextos', 'cortextos1', 'config', 'enabled-agents.json'),
      'utf-8',
    ));
    expect(Object.keys(registry)).toEqual(['rick']);
  });

  it('atomically creates only missing F1-O3 identities disabled and is idempotent', async () => {
    await rosterCommand.parseAsync([
      'node', 'cli', 'apply', REAL_MANIFEST, '--disabled-only', '--apply', '--json',
    ]);

    const manifest = loadDeliveryRoster(REAL_MANIFEST);
    const registryPath = join(homeRoot, '.cortextos', 'cortextos1', 'config', 'enabled-agents.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
    expect(registry.rick.enabled).toBe(true);
    for (const seat of manifest.seats.filter(seat => seat.identity !== 'rick')) {
      const agentDir = join(projectRoot, 'orgs', 'atrium', 'agents', seat.identity);
      const config = JSON.parse(readFileSync(join(agentDir, 'config.json'), 'utf-8'));
      expect(config).toMatchObject({
        agent_name: seat.identity,
        enabled: false,
        telegram_polling: false,
        runtime: seat.runtime,
        model: seat.resolvedModel,
        profile: seat.requestedProfile,
        requested_model: seat.requestedModel,
        requested_profile: seat.requestedProfile,
        resolved_model: seat.resolvedModel,
        resolved_effort: seat.resolvedEffort,
        harness_seat: seat.seat,
      });
      expect(registry[seat.identity]).toMatchObject({
        enabled: false,
        telegram_polling: false,
        org: 'atrium',
        model: seat.resolvedModel,
        requested_model: seat.requestedModel,
        resolved_model: seat.resolvedModel,
      });
      expect(readFileSync(join(agentDir, '.env'), 'utf-8')).not.toMatch(/^(?:BOT_TOKEN|CHAT_ID|ALLOWED_USER)=/m);
    }

    const plan = planRosterApply(
      REAL_MANIFEST,
      manifest,
      projectRoot,
      join(homeRoot, '.cortextos', 'cortextos1'),
    );
    expect(plan.blockers).toEqual([]);
    expect(plan.create).toEqual([]);
    expect(plan.preserved).toEqual(['rick']);
    expect(plan.unchanged).toHaveLength(15);
  });
});
