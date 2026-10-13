import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SHADOW_ROSTER } from '../../../src/harness/roster.js';

const CONFIG_PATH = join(__dirname, '..', '..', '..', 'config', 'harness', 'roster.v21.json');
const LEGACY_HOSTS = new Set([
  'beth', 'birdperson', 'jerry', 'jessica',
  'automation', 'legacy-site', 'legacy-swarm', 'coder', 'content', 'data', 'outreach', 'qa',
  'morty', 'space-beth', 'security',
]);

describe('literal harness roster bindings', () => {
  it('maps every delivery seat to its literal physical identity with no legacy substitution', () => {
    expect(SHADOW_ROSTER).toHaveLength(16);
    expect(SHADOW_ROSTER.map(seat => seat.logicalSeat)).toEqual([
      'f0', 'f1', 'f2', 'f3', 'f4',
      'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8',
      'o1', 'o2', 'o3',
    ]);
    for (const seat of SHADOW_ROSTER) {
      expect(seat.physicalAgent).toBe(seat.logicalSeat === 'f0' ? 'rick' : seat.logicalSeat);
      expect(LEGACY_HOSTS.has(seat.physicalAgent)).toBe(false);
      expect(seat.enabled).toBe(false);
    }
    expect(new Set(SHADOW_ROSTER.map(seat => seat.physicalAgent)).size).toBe(16);
  });

  it('keeps the checked-in roster config fail-closed and identical to runtime bindings', () => {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    expect(raw).not.toContain('compatibilityHostIdentity');
    const config = JSON.parse(raw) as {
      dispatchEnabled: boolean;
      deliveryCount: number;
      seats: Array<{
        alias: string;
        physicalIdentity: string;
        enabled: boolean;
        telegramPolling: boolean;
      }>;
    };
    expect(config.dispatchEnabled).toBe(false);
    expect(config.deliveryCount).toBe(16);
    expect(config.seats).toHaveLength(16);
    expect(config.seats.map(seat => [seat.alias, seat.physicalIdentity])).toEqual(
      SHADOW_ROSTER.map(seat => [seat.logicalSeat, seat.physicalAgent]),
    );
    expect(config.seats.every(seat => seat.enabled === false && seat.telegramPolling === false)).toBe(true);
    expect(config.seats.every(seat => !LEGACY_HOSTS.has(seat.physicalIdentity))).toBe(true);
  });
});
