// The values that differ from one install to the next: which org and seats the memory views read,
// where the vault is, the display timezone, and the optional feeds. Each reads an env var and falls
// back to the default documented in framework/dashboard/.env.example. Nothing here names a person,
// a seat or a host; set the env vars for your own install.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CTX_FRAMEWORK_ROOT, getAgentsForOrg, getEnabledAgents, getOrgContextPath, getOrgs } from '@/lib/config';

const env = (k: string) => (process.env[k] ?? '').trim();
const list = (k: string) => env(k).split(',').map((s) => s.trim()).filter(Boolean);
const tilde = (p: string) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

function orgContext(org: string): { orchestrator?: string } {
  try {
    return JSON.parse(fs.readFileSync(getOrgContextPath(org), 'utf8'));
  } catch {
    return {};
  }
}

/** The org the memory, wiki and fleet views read: CTX_ORG, else the first org found. */
export function defaultOrg(): string {
  const orgs = getOrgs();
  const want = env('CTX_ORG');
  return want && orgs.includes(want) ? want : (orgs[0] ?? '');
}

/** The seat that keeps the people index (ENTITIES.md), the checkpoint (STATE.md) and the proof tools:
 *  CTX_MEMORY_SEAT, else the org's orchestrator from its context.json. Empty when neither is set. */
export function memorySeat(org = defaultOrg()): string {
  return env('CTX_MEMORY_SEAT') || orgContext(org).orchestrator || '';
}

/** Folder of an agent seat inside an org. */
export function seatDir(seat: string, org = defaultOrg()): string {
  return path.join(CTX_FRAMEWORK_ROOT, 'orgs', org, 'agents', seat);
}

/** Seats shown on the memory views: CTX_MEMORY_SEATS (comma list), else the org's switched-on seats. */
export function memorySeats(org = defaultOrg()): string[] {
  const set = list('CTX_MEMORY_SEATS');
  if (set.length > 0) return set;
  const enabled = getEnabledAgents();
  return getAgentsForOrg(org).filter((a) => !enabled || enabled.has(a)).sort();
}

/** The Obsidian vault (readable copy of GBrain): CTX_VAULT_PATH. Unset = no vault views. */
export const VAULT = tilde(env('CTX_VAULT_PATH'));

/** Claude Code keeps a seat's saved lessons in ~/.claude/projects/<path, non-alphanumerics as ->/memory. */
export function lessonsDir(seatPath: string): string {
  return path.join(os.homedir(), '.claude', 'projects', seatPath.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
}

/** Names in the people index that are not CRM contacts (friends, family): CTX_CRM_EXCLUDE, comma list. */
export const CRM_EXCLUDE = list('CTX_CRM_EXCLUDE').map((s) => s.toLowerCase());

/** Assignee names that mean a person, not a seat: 'human', 'user', plus CTX_HUMAN_ASSIGNEES (comma list). */
export const HUMAN_ASSIGNEES = ['human', 'user', ...list('CTX_HUMAN_ASSIGNEES').map((s) => s.toLowerCase())];

/** Our own email addresses or domains (e.g. example.com), never listed as a contact's or as a lead:
 *  CTX_CRM_OWN, comma list. */
export const CRM_OWN = list('CTX_CRM_OWN').map((s) => s.toLowerCase());

/** Optional lead watch feed for the CRM: CTX_LEAD_WATCH_FILE (JSON state file) and CTX_LEAD_RECIPIENT
 *  (who leads are sent to). Unset = no lead rows. */
export const LEAD_WATCH_FILE = tilde(env('CTX_LEAD_WATCH_FILE'));
export const LEAD_RECIPIENT = env('CTX_LEAD_RECIPIENT');

/** Optional Instagram schedule: CTX_IG_CONVEYOR_DIR (folder with schedule.json) and CTX_IG_ACCOUNT. */
export const IG_CONVEYOR_DIR = tilde(env('CTX_IG_CONVEYOR_DIR'));
export const IG_ACCOUNT = env('CTX_IG_ACCOUNT');

/** Contact sent with web push (VAPID subject): CTX_PUSH_CONTACT, a mailto: or https: URL. */
export const PUSH_CONTACT = env('CTX_PUSH_CONTACT') || 'mailto:admin@localhost';

/** gh config folder used to refresh the ogl-cortex mirror: CTX_GH_CONFIG_DIR, else gh's own default. */
export const GH_CONFIG_DIR = tilde(env('CTX_GH_CONFIG_DIR'));
