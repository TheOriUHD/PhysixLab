import { describe, expect, it } from 'vitest';
import { qfromAxisAngle, qrot, type Quat, type Vec3 } from '../src/core/math';
import { centreOf, moveCentre, rotateBy, type PoseItem } from '../src/model/edit/rotateBy';

const ID: Quat = [0, 0, 0, 1];
const item = (id: string, position: Vec3, rotation: Quat = ID): PoseItem => ({ id, position, rotation });
const close = (a: readonly number[], b: readonly number[], d = 10) =>
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], d));

describe('rotate by angle', () => {
  it('a single object turned 15° about world Y keeps its position and gains a 15° yaw', () => {
    const [r] = rotateBy([item('a', [1, 2, 3])], 1, 15, 'world');
    close(r.position, [1, 2, 3]);
    close(r.rotation, qfromAxisAngle([0, 1, 0], (15 * Math.PI) / 180));
  });
  it('two objects at x = ±1 turned 90° about world Y swing round their centre: (1,0,0) -> (0,0,-1)', () => {
    const [a, b] = rotateBy([item('a', [1, 0, 0]), item('b', [-1, 0, 0])], 1, 90, 'world');
    close(a.position, [0, 0, -1]);
    close(b.position, [0, 0, 1]);
    // both objects turned by the same 90°
    close(qrot(a.rotation, [1, 0, 0]), [0, 0, -1]);
  });
  it('an explicit pivot is honoured', () => {
    const [a] = rotateBy([item('a', [2, 0, 0])], 1, 180, 'world', [1, 0, 0]);
    close(a.position, [0, 0, 0]);
  });
  it('local space turns each object about its own axis without moving it', () => {
    // a box lying on its side (90° about X): local Y is world -Z... rotating 90° about local Y keeps position
    const side = qfromAxisAngle([1, 0, 0], Math.PI / 2);
    const out = rotateBy([item('a', [1, 0, 0], side), item('b', [-1, 0, 0], side)], 1, 90, 'local');
    close(out[0].position, [1, 0, 0]);
    close(out[1].position, [-1, 0, 0]);
    // local Y of the sideways box is world -Z... check: the new local +X axis equals old local -Z axis
    const oldZ = qrot(side, [0, 0, 1]);
    close(
      qrot(out[0].rotation, [1, 0, 0]),
      oldZ.map((v) => -v),
    );
  });
  it('local and world agree for an unrotated object', () => {
    const w = rotateBy([item('a', [0, 1, 0])], 2, 33, 'world')[0];
    const l = rotateBy([item('a', [0, 1, 0])], 2, 33, 'local')[0];
    close(w.rotation, l.rotation);
  });
  it('rotating by 360° returns to the start, and by a and then -a is the identity', () => {
    const start = [item('a', [1, 0, 0]), item('b', [0, 0, 2], qfromAxisAngle([1, 1, 0], 0.4))];
    const full = rotateBy(start, [0, 1, 0], 360, 'world');
    close(full[0].position, start[0].position, 9);
    const back = rotateBy(rotateBy(start, 0, 27, 'world'), 0, -27, 'world');
    close(back[1].position, start[1].position, 9);
    expect(Math.abs(back[1].rotation.reduce((s, v, i) => s + v * start[1].rotation[i], 0))).toBeCloseTo(1, 9);
  });
  it('the result rotation is a unit quaternion', () => {
    const [r] = rotateBy([item('a', [0, 0, 0], qfromAxisAngle([0, 0, 1], 1.3))], 0, 77, 'world');
    expect(Math.hypot(...r.rotation)).toBeCloseTo(1, 12);
  });
});

describe('multi-selection centre', () => {
  it('is the mean position and moving it shifts everything by the same amount', () => {
    const items = [item('a', [0, 0, 0]), item('b', [2, 0, 4])];
    expect(centreOf(items)).toEqual([1, 0, 2]);
    const moved = moveCentre(items, 0, 5);
    expect(moved[0].position).toEqual([4, 0, 0]);
    expect(moved[1].position).toEqual([6, 0, 4]);
    expect(centreOf(moved)[0]).toBeCloseTo(5, 12);
    expect(centreOf(moved)[2]).toBeCloseTo(2, 12);
  });
});
