import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// A fresh install has no CTX_ROOT/orgs yet: the Team page must render, not throw.
let root: string;
let saved: { root?: string; fw?: string };

beforeEach(() => {
  saved = { root: process.env.CTX_ROOT, fw: process.env.CTX_FRAMEWORK_ROOT };
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-test-'));
  process.env.CTX_ROOT = root;
  process.env.CTX_FRAMEWORK_ROOT = root;
  vi.resetModules();
});

afterEach(() => {
  for (const [k, v] of [['CTX_ROOT', saved.root], ['CTX_FRAMEWORK_ROOT', saved.fw]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('team on a fresh install', () => {
  it('returns an empty team when CTX_ROOT/orgs does not exist', async () => {
    const { team } = await import('../team');
    expect(team().seats).toEqual([]);
  });

  it('lists switched-on seats with no work when there are no org folders yet', async () => {
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config', 'enabled-agents.json'), JSON.stringify({ boss: { enabled: true } }));
    const { team } = await import('../team');
    const seats = team().seats;
    expect(seats.map((s) => s.name)).toEqual(['boss']);
    expect(seats[0]).toMatchObject({ now: [], doneToday: [], stuck: 0, heartbeatAgeMin: null });
  });
});
