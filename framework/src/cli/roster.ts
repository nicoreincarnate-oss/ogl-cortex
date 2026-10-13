import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { isAbsolute, join, resolve } from 'path';
import { provisionDisabledAgents, type DisabledAgentSpec } from './disabled-agent-provisioning.js';
import { validateAgentName, validateInstanceId, validateOrgName } from '../utils/validate.js';

type RuntimeKind = DisabledAgentSpec['runtime'];

export interface DeliveryRosterSeat {
  seat: string;
  identity: string;
  pool: 'fable' | 'sonnet' | 'opus';
  runtime: RuntimeKind;
  requestedModel: string;
  requestedProfile: string;
  resolvedModel: string;
  resolvedEffort: string;
  lifecycle: string;
  launchMode: string;
  template: string;
  provisioning: 'existing-only' | 'create-disabled';
  telegramPolling: false;
  enabled: false;
}

export interface DeliveryRosterManifest {
  schemaVersion: 21;
  kind: 'cortex-delivery-roster';
  mode: 'disabled-only';
  deliveryCount: 16;
  instanceId: string;
  organization: string;
  dispatchEnabled: false;
  seats: DeliveryRosterSeat[];
}

export interface RosterValidationResult {
  valid: boolean;
  errors: string[];
  manifest?: DeliveryRosterManifest;
}

export interface RosterApplyPlan {
  manifestPath: string;
  instanceId: string;
  organization: string;
  dryRun: boolean;
  preserved: string[];
  create: string[];
  unchanged: string[];
  blockers: string[];
}

type ExpectedSeat = Omit<DeliveryRosterSeat, 'telegramPolling' | 'enabled'>;

const EXPECTED_SEATS: ExpectedSeat[] = [
  { seat: 'F0', identity: 'rick', pool: 'fable', runtime: 'claude-code', requestedModel: 'fable-5', requestedProfile: 'ultra', resolvedModel: 'claude-fable-5[1m]', resolvedEffort: 'max', lifecycle: 'portfolio-persistent', launchMode: 'sandboxed-portfolio-session', template: 'agent', provisioning: 'existing-only' },
  // Effort tiers: only the two main brains run ultra — F0/rick
  // (main planner) and C1 (lead builder). All support seats run high to cut cost
  // and provider rate-limit exposure. requestedProfile 'high' → resolvedEffort 'high'.
  ...[1, 2, 3, 4].map((n): ExpectedSeat => ({ seat: `F${n}`, identity: `f${n}`, pool: 'fable', runtime: 'claude-code', requestedModel: 'fable-5', requestedProfile: 'high', resolvedModel: 'claude-fable-5[1m]', resolvedEffort: 'high', lifecycle: 'project-generation-persistent', launchMode: 'generation-shim-only', template: 'agent', provisioning: 'create-disabled' })),
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n): ExpectedSeat => ({ seat: `C${n}`, identity: `c${n}`, pool: 'sonnet', runtime: 'claude-code', requestedModel: 'sonnet-5.5', requestedProfile: n === 1 ? 'ultra' : 'high', resolvedModel: 'claude-sonnet-5-5', resolvedEffort: n === 1 ? 'ultra' : 'high', lifecycle: 'attempt-fresh', launchMode: 'receiver-only', template: 'agent', provisioning: 'create-disabled' })),
  { seat: 'O1', identity: 'o1', pool: 'opus', runtime: 'claude-code', requestedModel: 'opus-4.8', requestedProfile: 'high', resolvedModel: 'claude-opus-4-8[1m]', resolvedEffort: 'high', lifecycle: 'attempt-fresh', launchMode: 'receiver-only', template: 'agent', provisioning: 'create-disabled' },
  { seat: 'O2', identity: 'o2', pool: 'opus', runtime: 'claude-code', requestedModel: 'opus-4.8', requestedProfile: 'high', resolvedModel: 'claude-opus-4-8[1m]', resolvedEffort: 'high', lifecycle: 'attempt-fresh', launchMode: 'receiver-only', template: 'agent', provisioning: 'create-disabled' },
  { seat: 'O3', identity: 'o3', pool: 'opus', runtime: 'claude-code', requestedModel: 'opus-4.8', requestedProfile: 'high', resolvedModel: 'claude-opus-4-8[1m]', resolvedEffort: 'high', lifecycle: 'candidate-fresh', launchMode: 'receiver-only', template: 'agent', provisioning: 'create-disabled' },
];

const TOP_LEVEL_KEYS = new Set([
  'schemaVersion', 'kind', 'mode', 'deliveryCount', 'instanceId',
  'organization', 'dispatchEnabled', 'seats',
]);
const SEAT_KEYS = new Set([
  'seat', 'identity', 'pool', 'runtime', 'requestedModel', 'requestedProfile',
  'resolvedModel', 'resolvedEffort', 'lifecycle',
  'launchMode', 'template', 'provisioning', 'telegramPolling', 'enabled',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function findUnresolvedTokens(value: unknown, path = '$', errors: string[] = []): string[] {
  if (typeof value === 'string') {
    const token = /RESOLVE_[A-Z0-9_]+|\{\{[^}]+\}\}|\$\{[^}]+\}|^(?:TODO|TBD|CHANGEME)$/i;
    if (token.test(value)) errors.push(`${path} contains an unresolved token`);
    return errors;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findUnresolvedTokens(entry, `${path}[${index}]`, errors));
  } else if (isRecord(value)) {
    Object.entries(value).forEach(([key, entry]) => findUnresolvedTokens(entry, `${path}.${key}`, errors));
  }
  return errors;
}

export function validateDeliveryRoster(input: unknown): RosterValidationResult {
  const errors = findUnresolvedTokens(input);
  if (!isRecord(input)) return { valid: false, errors: [...errors, 'manifest must be a JSON object'] };

  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_KEYS.has(key)) errors.push(`unknown top-level field: ${key}`);
  }
  if (input.schemaVersion !== 21) errors.push('schemaVersion must equal 21');
  if (input.kind !== 'cortex-delivery-roster') errors.push('kind must equal cortex-delivery-roster');
  if (input.mode !== 'disabled-only') errors.push('mode must equal disabled-only');
  if (input.deliveryCount !== 16) errors.push('deliveryCount must equal 16');
  if (input.dispatchEnabled !== false) errors.push('dispatchEnabled must be false');
  if (typeof input.instanceId !== 'string') errors.push('instanceId must be a string');
  else {
    try { validateInstanceId(input.instanceId); } catch (error) { errors.push((error as Error).message); }
    if (input.instanceId !== 'cortextos1') errors.push('instanceId must equal cortextos1');
  }
  if (typeof input.organization !== 'string') errors.push('organization must be a string');
  else {
    try { validateOrgName(input.organization); } catch (error) { errors.push((error as Error).message); }
    if (input.organization !== 'atrium') errors.push('organization must equal atrium');
  }

  if (!Array.isArray(input.seats)) {
    errors.push('seats must be an array');
    return { valid: false, errors };
  }
  if (input.seats.length !== 16) errors.push(`seats must contain exactly 16 rows (found ${input.seats.length})`);

  const bySeat = new Map<string, Record<string, unknown>>();
  const identities = new Set<string>();
  input.seats.forEach((candidate, index) => {
    if (!isRecord(candidate)) {
      errors.push(`seats[${index}] must be an object`);
      return;
    }
    for (const key of Object.keys(candidate)) {
      if (!SEAT_KEYS.has(key)) errors.push(`seats[${index}] has unknown field: ${key}`);
      if (/compatibilityhostidentity/i.test(key)) errors.push(`seats[${index}] may not use compatibility host mappings`);
    }
    if (typeof candidate.seat !== 'string') errors.push(`seats[${index}].seat must be a string`);
    else if (bySeat.has(candidate.seat)) errors.push(`duplicate seat: ${candidate.seat}`);
    else bySeat.set(candidate.seat, candidate);

    if (typeof candidate.identity !== 'string') errors.push(`seats[${index}].identity must be a string`);
    else {
      try { validateAgentName(candidate.identity); } catch (error) { errors.push((error as Error).message); }
      if (identities.has(candidate.identity)) errors.push(`duplicate physical identity: ${candidate.identity}`);
      identities.add(candidate.identity);
    }
    if (candidate.telegramPolling !== false) errors.push(`seats[${index}].telegramPolling must be false`);
    if (candidate.enabled !== false) errors.push(`seats[${index}].enabled must be false`);
  });

  for (const expected of EXPECTED_SEATS) {
    const actual = bySeat.get(expected.seat);
    if (!actual) {
      errors.push(`missing required seat: ${expected.seat}`);
      continue;
    }
    for (const [key, value] of Object.entries(expected)) {
      if (actual[key] !== value) {
        errors.push(`${expected.seat}.${key} must equal ${JSON.stringify(value)} (found ${JSON.stringify(actual[key])})`);
      }
    }
  }
  for (const seat of bySeat.keys()) {
    if (!EXPECTED_SEATS.some(expected => expected.seat === seat)) errors.push(`unexpected seat: ${seat}`);
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, errors: [], manifest: input as unknown as DeliveryRosterManifest };
}

export function loadDeliveryRoster(path: string): DeliveryRosterManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    throw new Error(`Unable to read roster manifest ${path}: ${(error as Error).message}`);
  }
  const result = validateDeliveryRoster(parsed);
  if (!result.valid || !result.manifest) {
    throw new Error(`Roster validation failed:\n- ${result.errors.join('\n- ')}`);
  }
  return result.manifest;
}

function discoverProjectRoot(): string {
  return process.env.CTX_FRAMEWORK_ROOT || process.env.CTX_PROJECT_ROOT || process.cwd();
}

function resolveManifestPath(input: string | undefined, projectRoot: string): string {
  if (!input) return join(projectRoot, 'config', 'harness', 'roster.delivery.v21.json');
  return isAbsolute(input) ? input : resolve(process.cwd(), input);
}

function readRegistryForPlan(path: string): Record<string, Record<string, unknown>> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf-8')); }
  catch { throw new Error(`Registry is not valid JSON: ${path}`); }
  if (!isRecord(parsed)) throw new Error(`Registry must be a JSON object: ${path}`);
  return parsed as Record<string, Record<string, unknown>>;
}

function readConfig(path: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf-8')); }
  catch { throw new Error(`Config is not valid JSON: ${path}`); }
  if (!isRecord(parsed)) throw new Error(`Config must be a JSON object: ${path}`);
  return parsed;
}

function credentialFieldsWithValues(path: string): string[] {
  if (!existsSync(path)) return [];
  const sensitive = new Set(['BOT_TOKEN', 'CHAT_ID', 'ALLOWED_USER']);
  const found: string[] = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    if (sensitive.has(key) && trimmed.slice(index + 1).trim()) found.push(key);
  }
  return found;
}

export function planRosterApply(
  manifestPath: string,
  manifest: DeliveryRosterManifest,
  projectRoot: string,
  ctxRoot: string,
): RosterApplyPlan {
  const plan: RosterApplyPlan = {
    manifestPath,
    instanceId: manifest.instanceId,
    organization: manifest.organization,
    dryRun: true,
    preserved: [],
    create: [],
    unchanged: [],
    blockers: [],
  };
  const registryPath = join(ctxRoot, 'config', 'enabled-agents.json');
  let registry: Record<string, Record<string, unknown>>;
  try { registry = readRegistryForPlan(registryPath); }
  catch (error) {
    plan.blockers.push((error as Error).message);
    return plan;
  }

  const agentsRoot = join(projectRoot, 'orgs', manifest.organization, 'agents');
  for (const seat of manifest.seats) {
    const agentDir = join(agentsRoot, seat.identity);
    const configPath = join(agentDir, 'config.json');
    const dirExists = existsSync(agentDir);
    const registryEntry = registry[seat.identity];

    if (seat.provisioning === 'existing-only') {
      if (!dirExists || !existsSync(configPath) || !registryEntry) {
        plan.blockers.push(`${seat.seat}/${seat.identity} is existing-only but its config or registry entry is missing`);
        continue;
      }
      try {
        const config = readConfig(configPath);
        if (config.agent_name !== seat.identity) {
          plan.blockers.push(`${seat.seat}/${seat.identity} config.agent_name does not match its physical identity`);
          continue;
        }
      } catch (error) {
        plan.blockers.push((error as Error).message);
        continue;
      }
      // F0 migration/activation is deliberately outside this command. It is
      // observed as a literal identity, never mutated or enabled here.
      plan.preserved.push(seat.identity);
      continue;
    }

    if (!dirExists && !registryEntry) {
      plan.create.push(seat.identity);
      continue;
    }
    if (!dirExists || !existsSync(configPath) || !registryEntry) {
      plan.blockers.push(`${seat.seat}/${seat.identity} is partially provisioned; refusing repair or overwrite`);
      continue;
    }

    try {
      const config = readConfig(configPath);
      const expectedConfig: Record<string, unknown> = {
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
        harness_pool: seat.pool,
        harness_lifecycle: seat.lifecycle,
        harness_launch_mode: seat.launchMode,
      };
      for (const [key, value] of Object.entries(expectedConfig)) {
        if (config[key] !== value) {
          plan.blockers.push(`${seat.seat}/${seat.identity} config.${key} must equal ${JSON.stringify(value)}`);
        }
      }
      const expectedRegistry: Record<string, unknown> = {
        enabled: false,
        telegram_polling: false,
        org: manifest.organization,
        runtime: seat.runtime,
        model: seat.resolvedModel,
        profile: seat.requestedProfile,
        requested_model: seat.requestedModel,
        requested_profile: seat.requestedProfile,
        resolved_model: seat.resolvedModel,
        resolved_effort: seat.resolvedEffort,
        harness_seat: seat.seat,
      };
      for (const [key, value] of Object.entries(expectedRegistry)) {
        if (registryEntry[key] !== value) {
          plan.blockers.push(`${seat.seat}/${seat.identity} registry.${key} must equal ${JSON.stringify(value)}`);
        }
      }
      const credentialFields = credentialFieldsWithValues(join(agentDir, '.env'));
      if (credentialFields.length > 0) {
        plan.blockers.push(`${seat.seat}/${seat.identity} has forbidden Telegram credential values: ${credentialFields.join(', ')}`);
      }
      if (!plan.blockers.some(blocker => blocker.startsWith(`${seat.seat}/${seat.identity} `))) {
        plan.unchanged.push(seat.identity);
      }
    } catch (error) {
      plan.blockers.push((error as Error).message);
    }
  }
  return plan;
}

function printPlan(plan: RosterApplyPlan, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  console.log(`Roster ${plan.dryRun ? 'dry-run' : 'apply'}: ${plan.organization}/${plan.instanceId}`);
  console.log(`  preserve existing-only: ${plan.preserved.join(', ') || '(none)'}`);
  console.log(`  create disabled: ${plan.create.join(', ') || '(none)'}`);
  console.log(`  already exact: ${plan.unchanged.join(', ') || '(none)'}`);
  if (plan.blockers.length > 0) {
    console.log('  blockers:');
    plan.blockers.forEach(blocker => console.log(`    - ${blocker}`));
  }
}

const validateCommand = new Command('validate')
  .argument('[manifest]', 'Roster manifest path')
  .option('--json', 'Print machine-readable output', false)
  .description('Validate the exact 16-seat disabled delivery roster')
  .action((manifestInput: string | undefined, options: { json: boolean }) => {
    const projectRoot = discoverProjectRoot();
    const manifestPath = resolveManifestPath(manifestInput, projectRoot);
    const manifest = loadDeliveryRoster(manifestPath);
    const output = {
      valid: true,
      manifestPath,
      seats: manifest.seats.length,
      identities: manifest.seats.map(seat => seat.identity),
      dispatchEnabled: manifest.dispatchEnabled,
    };
    if (options.json) console.log(JSON.stringify(output, null, 2));
    else console.log(`Valid disabled roster: ${manifest.seats.length} literal seats (${manifestPath})`);
  });

const applyCommand = new Command('apply')
  .argument('[manifest]', 'Roster manifest path')
  .requiredOption('--disabled-only', 'Refuse any enabled provisioning path')
  .option('--apply', 'Commit the disabled-only transaction (default is dry-run)', false)
  .option('--json', 'Print machine-readable output', false)
  .description('Plan or atomically create missing F1-F4/C1-C8/O1-O3 identities disabled')
  .action((manifestInput: string | undefined, options: { disabledOnly: boolean; apply: boolean; json: boolean }) => {
    if (options.disabledOnly !== true) throw new Error('--disabled-only is required');
    const projectRoot = discoverProjectRoot();
    const manifestPath = resolveManifestPath(manifestInput, projectRoot);
    const manifest = loadDeliveryRoster(manifestPath);
    const ctxRoot = join(homedir(), '.cortextos', manifest.instanceId);
    const plan = planRosterApply(manifestPath, manifest, projectRoot, ctxRoot);

    if (!options.apply) {
      printPlan(plan, options.json);
      if (plan.blockers.length > 0) {
        throw new Error(`Roster dry-run found ${plan.blockers.length} blocker(s)`);
      }
      return;
    }
    if (plan.blockers.length > 0) {
      printPlan(plan, options.json);
      throw new Error(`Roster apply refused with ${plan.blockers.length} blocker(s)`);
    }

    const createSet = new Set(plan.create);
    const specs: DisabledAgentSpec[] = manifest.seats
      .filter(seat => createSet.has(seat.identity))
      .map(seat => ({
        identity: seat.identity,
        org: manifest.organization,
        runtime: seat.runtime,
        template: seat.template,
        model: seat.resolvedModel,
        profile: seat.requestedProfile,
        requestedModel: seat.requestedModel,
        requestedProfile: seat.requestedProfile,
        resolvedModel: seat.resolvedModel,
        resolvedEffort: seat.resolvedEffort,
        seat: seat.seat,
        pool: seat.pool,
        lifecycle: seat.lifecycle,
        launchMode: seat.launchMode,
      }));
    provisionDisabledAgents({ projectRoot, ctxRoot, specs });

    const verified = planRosterApply(manifestPath, manifest, projectRoot, ctxRoot);
    verified.dryRun = false;
    if (verified.blockers.length > 0 || verified.create.length > 0) {
      throw new Error(`Roster postcondition failed:\n- ${verified.blockers.join('\n- ')}`);
    }
    printPlan(verified, options.json);
  });

export const rosterCommand = new Command('roster')
  .description('Validate and provision the literal Cortex delivery roster')
  .addCommand(validateCommand)
  .addCommand(applyCommand);
