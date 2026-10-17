import { describe, it, expect } from 'vitest';
import { buildPrompt, parseAnswer } from '../plain';

describe('plain task lines', () => {
  it('puts every id and title in the prompt', () => {
    const p = buildPrompt([{ id: 'task_1', title: 'P3: watch hooks' }, { id: 'task_2', title: 'Cheers live check' }]);
    expect(p).toContain('task_1: P3: watch hooks');
    expect(p).toContain('task_2: Cheers live check');
  });
  it('takes only the asked ids from the answer, even with text around the JSON', () => {
    const a = parseAnswer('Here you go: {"task_1": "Checking the safety hooks.", "task_9": "extra"}', ['task_1', 'task_2']);
    expect(a).toEqual({ task_1: 'Checking the safety hooks.' });
  });
  it('returns nothing for an answer that is not JSON, so the raw title stays', () => {
    expect(parseAnswer('sorry, I cannot', ['task_1'])).toEqual({});
  });
});
