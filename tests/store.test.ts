import { describe, expect, it } from 'vitest';
import { createBody, createJoint, newDocument } from '../src/model/factory';
import { SceneStore, type SceneChange } from '../src/model/store';
import { parseDocument, sanitizeDocument, serializeDocument } from '../src/model/serialize';
import type { BodyEntity } from '../src/model/types';
import { isBody } from '../src/model/types';

const box = (name: string, x = 0) => createBody({ name, shape: { type: 'box' }, position: [x, 0.5, 0] });

describe('SceneStore history', () => {
  it('undoes and redoes adds, edits and deletes with precise change events', () => {
    const s = new SceneStore();
    const events: SceneChange[] = [];
    s.on('change', (c) => events.push(c));
    const a = box('A'),
      b = box('B', 2);
    s.add([a], 'Add A');
    s.add([b], 'Add B');
    s.update(a.id, { name: 'Alpha' }, 'Rename');
    expect(s.body(a.id)!.name).toBe('Alpha');
    s.remove([b.id]);
    expect(s.size).toBe(1);
    expect(s.undo()).toBe('Delete');
    expect(s.size).toBe(2);
    expect(s.undo()).toBe('Rename');
    expect(s.body(a.id)!.name).toBe('A');
    expect(s.redo()).toBe('Rename');
    expect(s.body(a.id)!.name).toBe('Alpha');
    expect(events.map((e) => e.type)).toContain('remove');
    const last = events[events.length - 1];
    expect(last.type).toBe('update');
  });

  it('groups a batch into a single undo step', () => {
    const s = new SceneStore();
    const a = box('A');
    s.add([a]);
    s.begin('Drag');
    for (let i = 1; i <= 20; i++) s.update(a.id, { position: [i, 0.5, 0] });
    s.end();
    expect(s.body(a.id)!.position[0]).toBe(20);
    s.undo();
    expect(s.body(a.id)!.position[0]).toBe(0);
    expect(s.canUndo).toBe(true); // the add is still undoable
    s.undo();
    expect(s.size).toBe(0);
  });

  it('removing a body also removes its joints (and undo restores both)', () => {
    const s = new SceneStore();
    const a = box('A'),
      b = box('B', 2);
    const j = createJoint({ type: 'hinge', bodyA: a.id, bodyB: b.id, anchorA: [1, 0, 0] });
    s.add([a, b, j]);
    s.remove([a.id]);
    expect(s.size).toBe(1);
    s.undo();
    expect(s.size).toBe(3);
    expect(s.joint(j.id)).toBeDefined();
  });

  it('ignores no-op edits and keeps history clean', () => {
    const s = new SceneStore();
    const a = box('A');
    s.add([a]);
    const before = s.canUndo;
    s.update(a.id, { name: 'A' });
    s.undo();
    expect(before).toBe(true);
    expect(s.size).toBe(0); // the no-op created no extra history entry
  });

  it('duplicates assemblies with their internal joints re-linked', () => {
    const s = new SceneStore();
    const a = box('A'),
      b = box('B', 2);
    const joint = createJoint({ type: 'ball', bodyA: a.id, bodyB: b.id, anchorA: [1, 0, 0] });
    const worldJoint = createJoint({ type: 'ball', bodyA: null, bodyB: a.id, anchorA: [0, 5, 0] });
    s.add([a, b, joint, worldJoint]);
    const ids = s.duplicate([a.id, b.id], [0, 0, 3]);
    expect(ids.length).toBe(4); // two bodies + the internal joint + the world joint
    const copies = ids.map((id) => s.get(id)!);
    const copyBodies = copies.filter(isBody);
    expect(copyBodies.every((c) => c.position[2] === 3)).toBe(true);
    const joints = copies.filter((e) => e.kind === 'joint');
    expect(
      joints.every((j) => j.kind === 'joint' && (j.bodyA === null || copyBodies.some((b2) => b2.id === j.bodyA))),
    ).toBe(true);
    // the world-anchored side moved with the copy
    const wj = joints.find((j) => j.kind === 'joint' && j.bodyB && !j.bodyA);
    expect(wj && wj.kind === 'joint' && wj.anchorA[2]).toBe(3);
  });

  it('selection survives undo only for entities that still exist', () => {
    const s = new SceneStore();
    const a = box('A');
    s.add([a]);
    expect(s.selection).toEqual([a.id]);
    s.undo();
    expect(s.selection).toEqual([]);
  });
});

describe('serialization', () => {
  it('round-trips and fills defaults for sparse input', () => {
    const doc = newDocument('t');
    doc.entities.push(box('A'));
    const back = parseDocument(serializeDocument(doc));
    expect(back.entities).toHaveLength(1);
    const sparse = sanitizeDocument({
      format: 'physicslab-scene',
      entities: [{ kind: 'body', id: 'x', shape: { type: 'sphere', size: [2, 2, 2] } }],
    });
    const b = sparse.entities[0] as BodyEntity;
    expect(b.material.density).toBeGreaterThan(0);
    expect(b.rotation).toEqual([0, 0, 0, 1]);
    expect(b.bodyType).toBe('dynamic');
  });

  it('rejects garbage and drops dangling joints / bad numbers', () => {
    expect(() => parseDocument('not json')).toThrow();
    expect(() => parseDocument('{"format":"nope"}')).toThrow();
    const doc = sanitizeDocument({
      format: 'physicslab-scene',
      entities: [
        { kind: 'body', id: 'a', shape: { type: 'box', size: [1, -5, NaN] }, position: [Infinity, 0, 0] },
        { kind: 'joint', id: 'j', type: 'hinge', bodyA: 'a', bodyB: 'missing', anchorA: [0, 0, 0] },
      ],
    });
    expect(doc.entities).toHaveLength(1);
    const b = doc.entities[0] as BodyEntity;
    expect(b.shape.size.every((x) => x > 0 && Number.isFinite(x))).toBe(true);
    expect(b.position.every(Number.isFinite)).toBe(true);
  });
});
