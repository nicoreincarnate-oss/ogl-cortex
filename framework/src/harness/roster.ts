import type { RosterSeat } from './types.js';

/** Exact literal delivery roster. Logical seats map one-to-one to physical IDs. */
export const SHADOW_ROSTER: readonly RosterSeat[] = Object.freeze([
  { logicalSeat: 'f0', pool: 'fable', role: 'portfolio-interface', desiredRuntime: 'claude-code', desiredModel: 'fable-5', desiredProfile: 'ultra', physicalAgent: 'rick', enabled: false },
  { logicalSeat: 'f1', pool: 'fable', role: 'planning-replanning', desiredRuntime: 'claude-code', desiredModel: 'fable-5', desiredProfile: 'ultra', physicalAgent: 'f1', enabled: false },
  { logicalSeat: 'f2', pool: 'fable', role: 'planning-replanning', desiredRuntime: 'claude-code', desiredModel: 'fable-5', desiredProfile: 'ultra', physicalAgent: 'f2', enabled: false },
  { logicalSeat: 'f3', pool: 'fable', role: 'planning-replanning', desiredRuntime: 'claude-code', desiredModel: 'fable-5', desiredProfile: 'ultra', physicalAgent: 'f3', enabled: false },
  { logicalSeat: 'f4', pool: 'fable', role: 'planning-replanning', desiredRuntime: 'claude-code', desiredModel: 'fable-5', desiredProfile: 'ultra', physicalAgent: 'f4', enabled: false },
  { logicalSeat: 'c1', pool: 'sonnet', role: 'research-build-test', desiredRuntime: 'claude-code', desiredModel: 'sonnet-5.5', desiredProfile: 'ultra', physicalAgent: 'c1', enabled: false },
  { logicalSeat: 'c2', pool: 'sonnet', role: 'research-build-test', desiredRuntime: 'claude-code', desiredModel: 'sonnet-5.5', desiredProfile: 'ultra', physicalAgent: 'c2', enabled: false },
  { logicalSeat: 'c3', pool: 'sonnet', role: 'research-build-test', desiredRuntime: 'claude-code', desiredModel: 'sonnet-5.5', desiredProfile: 'ultra', physicalAgent: 'c3', enabled: false },
  { logicalSeat: 'c4', pool: 'sonnet', role: 'research-build-test', desiredRuntime: 'claude-code', desiredModel: 'sonnet-5.5', desiredProfile: 'ultra', physicalAgent: 'c4', enabled: false },
  { logicalSeat: 'c5', pool: 'sonnet', role: 'research-build-test', desiredRuntime: 'claude-code', desiredModel: 'sonnet-5.5', desiredProfile: 'ultra', physicalAgent: 'c5', enabled: false },
  { logicalSeat: 'c6', pool: 'sonnet', role: 'research-build-test', desiredRuntime: 'claude-code', desiredModel: 'sonnet-5.5', desiredProfile: 'ultra', physicalAgent: 'c6', enabled: false },
  { logicalSeat: 'c7', pool: 'sonnet', role: 'research-build-test', desiredRuntime: 'claude-code', desiredModel: 'sonnet-5.5', desiredProfile: 'ultra', physicalAgent: 'c7', enabled: false },
  { logicalSeat: 'c8', pool: 'sonnet', role: 'research-build-test', desiredRuntime: 'claude-code', desiredModel: 'sonnet-5.5', desiredProfile: 'ultra', physicalAgent: 'c8', enabled: false },
  { logicalSeat: 'o1', pool: 'opus', role: 'evidence-synthesis', desiredRuntime: 'claude-code', desiredModel: 'opus-4.8', desiredProfile: 'ultra', physicalAgent: 'o1', enabled: false },
  { logicalSeat: 'o2', pool: 'opus', role: 'blind-adversarial-review', desiredRuntime: 'claude-code', desiredModel: 'opus-4.8', desiredProfile: 'ultra', physicalAgent: 'o2', enabled: false },
  { logicalSeat: 'o3', pool: 'opus', role: 'reserved-final-arbiter', desiredRuntime: 'claude-code', desiredModel: 'opus-4.8', desiredProfile: 'ultra', physicalAgent: 'o3', enabled: false },
]);

export const PROJECT_SLOT_OWNERS = ['f1', 'f2', 'f3', 'f4'] as const;
