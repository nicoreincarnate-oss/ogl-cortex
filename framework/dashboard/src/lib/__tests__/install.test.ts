import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// install.ts reads env at import: each test sets env, then imports a fresh copy.
const KEYS = ['CTX_ROOT', 'CTX_FRAMEWORK_ROOT', 'CTX_ORG', 'CTX_MEMORY_SEAT', 'CTX_MEMORY_SEATS', 'CTX_VAULT_PATH', 'CTX_HUMAN_ASSIGNEES', 'CTX_PUSH_CONTACT'];
let saved: Record<string, string | undefined>;
let fw: string;

function seat(org: string, name: string) {
  fs.mkdirSync(path.join(fw, 'orgs', org, 'agents', name), { recursive: true });
}

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  fw = fs.mkdtempSync(path.join(os.tmpdir(), 'install-test-'));
  process.env.CTX_FRAMEWORK_ROOT = fw;
  process.env.CTX_ROOT = path.join(fw, 'state');
  vi.resetModules();
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(fw, { recursive: true, force: true });
});

describe('install settings', () => {
  it('defaults: first org, orchestrator from context.json, seats on disk, no vault, generic push contact', async () => {
    seat('alpha', 'boss');
    seat('alpha', 'helper');
    fs.writeFileSync(path.join(fw, 'orgs', 'alpha', 'context.json'), JSON.stringify({ orchestrator: 'boss' }));
    const m = await import('../install');
    expect(m.defaultOrg()).toBe('alpha');
    expect(m.memorySeat()).toBe('boss');
    expect(m.memorySeats()).toEqual(['boss', 'helper']);
    expect(m.VAULT).toBe('');
    expect(m.HUMAN_ASSIGNEES).toEqual(['human', 'user']);
    expect(m.PUSH_CONTACT).toBe('mailto:admin@localhost');
  });

  it('env overrides every default', async () => {
    seat('alpha', 'boss');
    seat('beta', 'lead');
    process.env.CTX_ORG = 'beta';
    process.env.CTX_MEMORY_SEAT = 'lead';
    process.env.CTX_MEMORY_SEATS = 'lead, other';
    process.env.CTX_VAULT_PATH = '~/Vault';
    process.env.CTX_HUMAN_ASSIGNEES = 'Alex';
    const m = await import('../install');
    expect(m.defaultOrg()).toBe('beta');
    expect(m.memorySeat()).toBe('lead');
    expect(m.memorySeats()).toEqual(['lead', 'other']);
    expect(m.VAULT).toBe(path.join(os.homedir(), 'Vault'));
    expect(m.HUMAN_ASSIGNEES).toEqual(['human', 'user', 'alex']);
  });

  it('ignores a CTX_ORG that does not exist', async () => {
    seat('alpha', 'boss');
    process.env.CTX_ORG = 'missing';
    const m = await import('../install');
    expect(m.defaultOrg()).toBe('alpha');
    expect(m.memorySeat()).toBe('');
  });

  it('maps a seat folder to its Claude Code lessons folder', async () => {
    const m = await import('../install');
    expect(m.lessonsDir('/home/u/cortex/orgs/o/agents/my-seat')).toBe(
      path.join(os.homedir(), '.claude', 'projects', '-home-u-cortex-orgs-o-agents-my-seat', 'memory'),
    );
    expect(m.lessonsDir('/a/.b_c')).toBe(path.join(os.homedir(), '.claude', 'projects', '-a--b-c', 'memory'));
  });
});
