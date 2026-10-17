import { describe, it, expect } from 'vitest';
import { extractPaths, findDrift, GRACE_MS, type DoneTask } from '../drift';

const task = (text: string, completed_at = '2026-10-09T20:00:00Z'): DoneTask => ({
  id: 't1', title: 'x', assignee: 'rick', org: 'atrium', completed_at, text,
});
const closed = Date.parse('2026-10-09T20:00:00Z');
const id = (_t: DoneTask, p: string) => p;

describe('extractPaths', () => {
  it('finds receipts and FILES paths, drops trailing punctuation', () => {
    expect(extractPaths('done. receipts: deliverables/a/b/. Also tools/x.py, see ~/Clients/c.html.')).toEqual([
      'deliverables/a/b/', 'tools/x.py', '~/Clients/c.html',
    ]);
  });
  it('skips files that move by design', () => {
    expect(extractPaths('memory/2026-10-09.md tools/a.log deliverables/x/state.json tools/b.jsonl')).toEqual([]);
  });
  it('skips folders too wide to pin on one task', () => {
    expect(extractPaths('see ~/Clients and tools/ and ~/.claude.json')).toEqual([]);
  });
  it('skips globs and unexpanded variables', () => {
    expect(extractPaths('deliverables/*.html tools/$X/y')).toEqual([]);
  });
});

describe('findDrift', () => {
  it('flags a done task whose file changed after it closed', () => {
    const rows = findDrift([task('receipts: deliverables/a.html')], id, () => ({ exists: true, mtimeMs: closed + 60 * 60000 }));
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('changed');
    expect(rows[0].minutesAfter).toBe(60);
  });
  it('stays quiet when the file was last written before close', () => {
    expect(findDrift([task('deliverables/a.html')], id, () => ({ exists: true, mtimeMs: closed - 1000 }))).toEqual([]);
  });
  it('stays quiet inside the grace window', () => {
    expect(findDrift([task('deliverables/a.html')], id, () => ({ exists: true, mtimeMs: closed + GRACE_MS }))).toEqual([]);
  });
  it('flags a receipt that no longer exists', () => {
    const rows = findDrift([task('receipts: deliverables/gone.html')], id, () => ({ exists: false, mtimeMs: 0 }));
    expect(rows[0].kind).toBe('gone');
  });
  it('ignores tasks with no usable close time', () => {
    expect(findDrift([task('deliverables/a.html', 'never')], id, () => ({ exists: true, mtimeMs: Date.now() }))).toEqual([]);
  });
});
