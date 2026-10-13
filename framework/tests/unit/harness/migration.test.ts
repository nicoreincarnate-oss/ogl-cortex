import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const EXPECTED_BYTES = 1_202_490;
const EXPECTED_SHA256 = 'f887cc7de8d70458d152e03326fa4a62f61ce2118cb02f6dcfd6a83fc9aa621a';
const migrationPath = join(process.cwd(), 'migrations', 'harness', '0021_v21.sql');

describe('generated Cortex Harness v2.1 migration', () => {
  it('is byte-identical to the audited Section 6 source block', () => {
    const migration = readFileSync(migrationPath);
    expect(migration.length).toBe(EXPECTED_BYTES);
    expect(createHash('sha256').update(migration).digest('hex')).toBe(EXPECTED_SHA256);
  });

  it('installs with the audited inventory and passes SQLite integrity checks', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(readFileSync(migrationPath, 'utf8'));
      const count = (type: string, extra = '') => Number(
        (db.prepare(
          `SELECT count(*) AS count FROM sqlite_schema WHERE type = ? ${extra}`,
        ).get(type) as { count: number }).count,
      );

      expect(count('table', "AND name NOT LIKE 'sqlite_%'")).toBe(157);
      expect(count('view')).toBe(8);
      expect(count('trigger')).toBe(696);
      expect(count('index', 'AND sql IS NOT NULL')).toBe(27);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally {
      db.close();
    }
  });
});
