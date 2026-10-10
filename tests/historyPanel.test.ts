import { describe, expect, it } from 'vitest';
import { createBody } from '../src/model/factory';
import { SceneStore } from '../src/model/store';

const box = (name: string) => createBody({ name, shape: { type: 'box' }, position: [0, 0.5, 0] });

function filled(n: number): SceneStore {
  const s = new SceneStore();
  for (let i = 1; i <= n; i++) s.add([box(`B${i}`)], `Add B${i}`);
  return s;
}

describe('history panel store API', () => {
  it('lists done and undone labels in the right order', () => {
    const s = filled(4);
    s.undo();
    s.undo();
    expect(s.historyEntries()).toEqual({ done: ['Add B1', 'Add B2'], undone: ['Add B3', 'Add B4'] });
  });

  it('jumps back, forward, to 0 and to the end with a single history event each', () => {
    const s = filled(5);
    let events = 0;
    s.on('history', () => events++);
    s.jumpTo(2);
    expect(s.size).toBe(2);
    expect(s.historyEntries().done).toHaveLength(2);
    expect(s.historyEntries().undone[0]).toBe('Add B3');
    expect(events).toBe(1);
    s.jumpTo(4);
    expect(s.size).toBe(4);
    s.jumpTo(0);
    expect(s.size).toBe(0);
    expect(s.canUndo).toBe(false);
    s.jumpTo(99);
    expect(s.size).toBe(5);
    expect(s.canRedo).toBe(false);
    s.jumpTo(5);
    expect(events).toBe(4);
  });

  it('a new edit after a jump discards the redo branch', () => {
    const s = filled(4);
    s.jumpTo(2);
    s.add([box('X')], 'Add X');
    expect(s.canRedo).toBe(false);
    expect(s.historyEntries().done).toEqual(['Add B1', 'Add B2', 'Add X']);
    expect(s.size).toBe(3);
  });

  it('trims to the history limit and honours a lowered limit', () => {
    const s = filled(30);
    s.historyLimit = 10;
    expect(s.historyEntries().done).toHaveLength(10);
    expect(s.historyEntries().done[0]).toBe('Add B21');
    s.add([box('Y')], 'Add Y');
    expect(s.historyEntries().done).toHaveLength(10);
    expect(s.historyEntries().done[9]).toBe('Add Y');
  });

  it('clearHistory keeps the document', () => {
    const s = filled(3);
    s.undo();
    s.clearHistory();
    expect(s.canUndo).toBe(false);
    expect(s.canRedo).toBe(false);
    expect(s.size).toBe(2);
  });
});
