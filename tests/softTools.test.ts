/** SF-1/2/3 UI helpers: frame conversions, attachment records, cutting triangle, rope / cable layout. */
import { describe, expect, it } from 'vitest';
import { qfromAxisAngle, qrot, vdist, vlen, vsub, type Vec3 } from '../src/core/math';
import { createBody, createSoft } from '../src/model/factory';
import { softSpacing } from '../src/model/softMaterial';
import {
  cableBetween,
  cableEndAttachment,
  cutTriangle,
  defaultAttachRadius,
  distToSegment2,
  jointBodyOf,
  localToWorld,
  regionAttachment,
  rimAttachment,
  ropeLinkCount,
  softCopyOf,
  worldToLocal,
} from '../src/ui/extensions/softPick';

const near = (a: Vec3, b: Vec3, tol = 1e-6) => expect(vdist(a, b)).toBeLessThan(tol);

describe('softPick', () => {
  it('worldToLocal inverts localToWorld for a rotated pose', () => {
    const pose = { position: [1, 2, 3] as Vec3, rotation: qfromAxisAngle([0, 1, 0], 0.7) };
    const p: Vec3 = [0.3, -0.4, 2];
    near(worldToLocal(pose, localToWorld(pose, p)), p);
  });

  it('a region attachment stores the soft-local centre, 1.5 spacings radius and the body-local offset', () => {
    const soft = createSoft('cloth', { position: [0, 3, 0], rotation: qfromAxisAngle([0, 0, 1], Math.PI / 2) });
    const body = createBody({ position: [2, 1, 0], rotation: qfromAxisAngle([0, 1, 0], Math.PI / 2) });
    const hit: Vec3 = [0, 3, 1];
    const att = regionAttachment(soft, hit, body, 'j1');
    near(localToWorld(soft, att.center), hit);
    near(localToWorld(body, att.offset), hit);
    expect(att.radius).toBeCloseTo(1.5 * softSpacing(soft), 9);
    expect(att.kind).toBe('region');
    expect(att.body).toBe(body.id);
    expect(att.joint).toBe('j1');
    expect(regionAttachment(soft, hit, body).joint).toBeUndefined();
  });

  it('the default radius never drops below 5 cm', () => {
    expect(defaultAttachRadius({ type: 'cloth', size: [0.1, 0, 0.1], resolution: 50, cell: 0.2 })).toBe(0.05);
  });

  it('a rim attachment sits at the tyre centre in the hub frame', () => {
    const tyre = createSoft('tyre', { position: [1, 1, 0] });
    const hub = createBody({ position: [1, 1.2, 0] });
    const att = rimAttachment(tyre, hub);
    expect(att.kind).toBe('rim');
    near(att.center, [0, 0, 0]);
    near(att.offset, [0, -0.2, 0], 1e-9);
    expect(att.radius).toBeGreaterThan(0);
  });

  it('a joint resolves to its non-world body, preferring the dynamic end', () => {
    expect(jointBodyOf({ bodyA: null, bodyB: 'b' }, () => true)).toBe('b');
    expect(jointBodyOf({ bodyA: 'a', bodyB: null }, () => true)).toBe('a');
    expect(jointBodyOf({ bodyA: null, bodyB: null }, () => true)).toBeNull();
    expect(jointBodyOf({ bodyA: 'a', bodyB: 'b' }, (id) => id === 'a')).toBe('a');
    expect(jointBodyOf({ bodyA: 'a', bodyB: 'b' }, () => true)).toBe('b');
  });

  it('the cutting triangle reaches 5 m beyond the soft body along each ray', () => {
    const t = cutTriangle([0, 2, 10], [0.1, 0, -1], [-0.1, 0, -1], 8);
    expect(vlen(vsub(t.a, t.origin))).toBeCloseTo(13, 6);
    expect(vlen(vsub(t.b, t.origin))).toBeCloseTo(13, 6);
    expect(t.a[0]).toBeGreaterThan(0);
    expect(t.b[0]).toBeLessThan(0);
  });

  it('point-segment distance in 2D', () => {
    expect(distToSegment2([5, 3], [0, 0], [10, 0])).toBeCloseTo(3, 9);
    expect(distToSegment2([-4, 3], [0, 0], [10, 0])).toBeCloseTo(5, 9);
    expect(distToSegment2([1, 1], [0, 0], [0, 0])).toBeCloseTo(Math.SQRT2, 9);
  });

  it('rope link count is one per 0.25 m clamped to 4 … 40', () => {
    expect(ropeLinkCount(0.3)).toBe(4);
    expect(ropeLinkCount(2)).toBe(8);
    expect(ropeLinkCount(100)).toBe(40);
  });

  it('a cable between two points is centred, aligned with its local X and sized by the distance', () => {
    const a: Vec3 = [0, 4, 0],
      b: Vec3 = [3, 4, 4];
    const c = cableBetween(a, b);
    near(c.position, [1.5, 4, 2]);
    expect(c.size[0]).toBeCloseTo(5, 9);
    near(localToWorld(c, [-2.5, 0, 0]), a, 1e-6);
    near(localToWorld(c, [2.5, 0, 0]), b, 1e-6);
    expect(c.resolution).toBe(40);
    expect(qrot(c.rotation, [1, 0, 0])[2]).toBeGreaterThan(0.7);
  });

  it('a cable end attachment is an 8 cm region at that end with the body-local offset', () => {
    const body = createBody({ position: [3, 4, 4] });
    const att = cableEndAttachment({ size: [5, 0, 0] }, false, [3, 4.5, 4], body);
    near(att.center, [2.5, 0, 0]);
    expect(att.radius).toBe(0.08);
    near(att.offset, [0, 0.5, 0]);
    near(cableEndAttachment({ size: [5, 0, 0] }, true, [3, 4, 4], body).center, [-2.5, 0, 0]);
  });

  it('a soft copy carries the shape, size and pose of its body', () => {
    const b = createBody({ position: [1, 2, 3], rotation: qfromAxisAngle([0, 1, 0], 0.5) });
    const over = softCopyOf(b, 'Soft X');
    expect(over.name).toBe('Soft X');
    expect(over.shape?.type).toBe(b.shape.type);
    expect(over.size).toEqual(b.shape.size);
    expect(over.size).not.toBe(b.shape.size);
    expect(over.position).toEqual([1, 2, 3]);
    expect(createSoft('mesh', over).shape.type).toBe(b.shape.type);
  });
});
