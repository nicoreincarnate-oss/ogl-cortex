import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Distribution-level regression guard for the node:sqlite packaging defect.
 *
 * The harness store loads the SQLite backend via a Node >=22 builtin
 * (`node:sqlite`). A prior tsup/esbuild build silently rewrote that specifier
 * to a bare `require("sqlite")` — an absent third-party package — so any
 * harness-enabled daemon start crashed at runtime even though the source and
 * unit tests were green. This test fails the build if that regression returns.
 */

const distDir = join(__dirname, '..', '..', '..', 'dist');
const builtEntrypoints = ['cli.js', 'daemon.js'];

describe('dist sqlite packaging', () => {
  const present = builtEntrypoints.filter((f) => existsSync(join(distDir, f)));
  const describeBuilt = present.length === builtEntrypoints.length ? describe : describe.skip;

  describeBuilt('built entrypoints', () => {
    for (const file of builtEntrypoints) {
      it(`${file} does not require an absent bare "sqlite" package`, () => {
        const src = readFileSync(join(distDir, file), 'utf8');
        // Bare require("sqlite") / require('sqlite') is the defect signature.
        expect(src).not.toMatch(/require\(\s*['"]sqlite['"]\s*\)/);
      });
    }
  });

  it('node:sqlite builtin is resolvable on this runtime', () => {
    const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
    if (nodeMajor < 22) return; // builtin only exists on Node >=22
    // Assembled the way the store does, so a static bundler cannot fold it.
    const specifier = ['node', 'sqlite'].join(':');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqlite = require(specifier) as typeof import('node:sqlite');
    expect(typeof sqlite.DatabaseSync).toBe('function');
  });
});
