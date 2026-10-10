/**
 * Zones, part 2 (ZN-2): every zone action against analytic expectations in the real engine — launch, gravity
 * override, force field, teleport, kill and respawn, respawn points, spawn, sound, score / label, enable / disable and
 * custom events.
 */
import { describe, expect, it } from 'vitest';
import { qfromAxisAngle, qrot, type Quat, type Vec3 } from '../src/core/math';
import { makeComponent } from '../src/model/componentRegistry';
import { defaultSettings } from '../src/model/factory';
import { ZONES_STATE_ID, type ZonesPublic } from '../src/model/zones';
import {
  at,
  ball,
  createBody,
  gauges,
  isOff,
  run,
  runCollect,
  runUntil,
  SPACE,
  worldOf,
  zoneBody,
  zoneEvents,
} from './zonesHelpers';

const G = 9.81;
const DT = 1 / 120;
// A zone learns of a body after the engine's first step (the overlap is reported by the step that finds it), so a
// field acts from the second step on: the first one is still plain gravity / no force.
const EARTH = { gravity: [0, -G, 0] as Vec3, ground: { ...defaultSettings().ground, enabled: false } };
const near = (v: number[], e: number[], d = 4) => v.forEach((x, i) => expect(x).toBeCloseTo(e[i], d));

describe('launch', () => {
  it('a launch pad adds a velocity change along the zone’s axes: a body at rest leaves at exactly (0, 8, 0)', async () => {
    const z = zoneBody({ action: 'launch', launch: [0, 8, 0] }, { size: [4, 1, 4] });
    const b = ball([0, 0, 0]);
    const w = await worldOf([z, b], SPACE);
    run(w, 0.1);
    near(w.getPose(b.id)!.linvel, [0, 8, 0]);
    const ev = zoneEvents(w, 'launch');
    expect(ev).toHaveLength(1);
    expect(ev[0].data).toMatchObject({ body: b.id, mode: 'deltaV', vector: [0, 8, 0] });
  });

  it('zone axes turn with the zone, world axes do not; the velocity the body had is kept', async () => {
    const q = qfromAxisAngle([0, 0, 1], Math.PI / 2); // local +y points along world −x
    const zone = zoneBody({ action: 'launch', launch: [0, 8, 0] }, { rotation: q, size: [4, 1, 4] });
    const b = ball([0, 0, 0], [0, 0, 3]);
    const w = await worldOf([zone, b], SPACE);
    run(w, 0.05);
    near(w.getPose(b.id)!.linvel, [-8, 0, 3]);
    const zw = zoneBody({ action: 'launch', launch: [0, 8, 0], space: 'world' }, { rotation: q, size: [4, 1, 4] });
    const b2 = ball([0, 0, 0]);
    const w2 = await worldOf([zw, b2], SPACE);
    run(w2, 0.05);
    near(w2.getPose(b2.id)!.linvel, [0, 8, 0]);
  });

  it('an impulse is mass-dependent: J = 10 N·s gives a 2 kg body 5 m/s', async () => {
    const z = zoneBody({ action: 'launch', launchMode: 'impulse', launch: [0, 10, 0] });
    const b = ball([0, 0, 0], [0, 0, 0], { massOverride: 2 });
    const w = await worldOf([z, b], SPACE);
    expect(w.builtInfo().mass[b.id]).toBeCloseTo(2, 6);
    run(w, 0.05);
    near(w.getPose(b.id)!.linvel, [0, 5, 0], 3);
  });

  it('a vehicle (a group of bodies) is launched as a whole: the impulse is shared by mass, every body gains J / M', async () => {
    const z = zoneBody(
      { action: 'launch', launchMode: 'impulse', launch: [0, 10, 0], unit: 'group' },
      { size: [20, 2, 4] },
    );
    const light = ball([-3, 0, 0], [0, 0, 0], { massOverride: 1, parent: 'car' });
    const heavy = ball([3, 0, 0], [0, 0, 0], { massOverride: 3, parent: 'car' });
    const w = await worldOf([z, light, heavy], SPACE);
    run(w, 0.05);
    near(w.getPose(light.id)!.linvel, [0, 2.5, 0], 3);
    near(w.getPose(heavy.id)!.linvel, [0, 2.5, 0], 3);
    expect(zoneEvents(w, 'launch')).toHaveLength(1); // once for the group, not once per body
  });

  it('cooldown and the trigger limit stop repeated launches', async () => {
    const mk = async (extra: Record<string, number>) => {
      const z = zoneBody({ action: 'launch', launch: [0, 0, 0], ...extra }, { position: [5, 0, 0], size: [2, 4, 4] });
      const b = ball([0, 0, 0], [10, 0, 0]);
      const w = await worldOf([z, b], SPACE);
      run(w, 0.8);
      w.setVelocity(b.id, [-10, 0, 0], [0, 0, 0]); // back through the zone
      run(w, 0.8);
      return gauges(w, z)[2];
    };
    expect(await mk({})).toBe(2);
    expect(await mk({ cooldown: 5 })).toBe(1);
    expect(await mk({ maxTriggers: 1 })).toBe(1);
  });
});

describe('gravity override', () => {
  it('weightless: a body inside keeps its velocity while one outside falls at g', async () => {
    const z = zoneBody({ action: 'gravity', gravity: [0, 0, 0] }, { position: [0, 0, 0], size: [10, 10, 10] });
    const inside = ball([0, 0, 0]);
    const outside = ball([30, 0, 0]);
    const w = await worldOf([z, inside, outside], EARTH);
    run(w, 1);
    expect(w.getPose(inside.id)!.linvel[1]).toBeCloseTo(-G * DT, 3); // only the first step fell
    expect(w.getPose(outside.id)!.linvel[1]).toBeCloseTo(-G, 2);
  });

  it('reversed gravity lifts: v = +g·t for a body inside', async () => {
    const z = zoneBody({ action: 'gravity', gravity: [0, G, 0] }, { size: [40, 40, 40] });
    const b = ball([0, 0, 0]);
    const w = await worldOf([z, b], EARTH);
    run(w, 1);
    expect(w.getPose(b.id)!.linvel[1]).toBeCloseTo(G * (1 - 2 * DT), 2); // one step down, 119 up
    expect(at(w, b.id)[1]).toBeGreaterThan(0.5 * G * 0.95);
    expect(at(w, b.id)[1]).toBeLessThan(0.5 * G);
  });

  it('sideways gravity: the zone’s vector replaces the scene’s in every component', async () => {
    const z = zoneBody({ action: 'gravity', gravity: [3, 0, -2] }, { size: [60, 60, 60] });
    const b = ball([0, 0, 0]);
    const w = await worldOf([z, b], EARTH);
    run(w, 1);
    near(w.getPose(b.id)!.linvel, [3 * (1 - DT), -G * DT, -2 * (1 - DT)], 2);
  });

  it('a body’s own gravity scale is honoured: half-gravity body in zero-g still floats', async () => {
    const z = zoneBody({ action: 'gravity', gravity: [0, 0, 0] }, { size: [40, 40, 40] });
    const b = ball([0, 0, 0], [0, 0, 0], { gravityScale: 0.5 });
    const w = await worldOf([z, b], EARTH);
    run(w, 1);
    expect(w.getPose(b.id)!.linvel[1]).toBeCloseTo(-0.5 * G * DT, 3);
  });

  it('where zones overlap the highest priority rules; a tie goes to the newer body', async () => {
    const mk = async (pa: number, pb: number) => {
      const a = zoneBody({ action: 'gravity', gravity: [0, 0, 0], priority: pa }, { size: [40, 40, 40] });
      const bz = zoneBody({ action: 'gravity', gravity: [0, G, 0], priority: pb }, { size: [40, 40, 40] });
      const b = ball([0, 0, 0]);
      const w = await worldOf([a, bz, b], EARTH);
      run(w, 1);
      return w.getPose(b.id)!.linvel[1];
    };
    expect(await mk(5, 0)).toBeCloseTo(-G * DT, 3); // a (zero-g) wins
    expect(await mk(0, 5)).toBeCloseTo(G * (1 - 2 * DT), 2); // b (reversed) wins
    expect(await mk(1, 1)).toBeCloseTo(G * (1 - 2 * DT), 2); // tie: the newer one, b
  });

  it('leaving the zone gives gravity back', async () => {
    const z = zoneBody({ action: 'gravity', gravity: [0, 0, 0] }, { position: [0, 0, 0], size: [4, 4, 4] });
    const b = ball([0, 0, 0], [6, 0, 0]);
    const w = await worldOf([z, b], EARTH);
    run(w, 0.3); // x = 1.8: still inside
    expect(w.getPose(b.id)!.linvel[1]).toBeCloseTo(-G * DT, 3);
    run(w, 1); // out at x > 2.25 after 0.4 s, then falls
    expect(w.getPose(b.id)!.linvel[1]).toBeLessThan(-G * 0.5);
  });
});

describe('force field', () => {
  it('uniform: an acceleration of 3 m/s² along x gives v = 3t for any mass', async () => {
    const z = zoneBody({ action: 'force', force: [3, 0, 0], perMass: true }, { size: [200, 20, 20] });
    const light = ball([0, 0, -3], [0, 0, 0], { massOverride: 1 });
    const heavy = ball([0, 0, 3], [0, 0, 0], { massOverride: 7 });
    const w = await worldOf([z, light, heavy], SPACE);
    run(w, 1);
    expect(w.getPose(light.id)!.linvel[0]).toBeCloseTo(3 * (1 - DT), 3);
    expect(w.getPose(heavy.id)!.linvel[0]).toBeCloseTo(3 * (1 - DT), 3);
  });

  it('as a force (not per mass): F = 6 N gives a = F/m', async () => {
    const z = zoneBody({ action: 'force', force: [6, 0, 0], perMass: false }, { size: [200, 20, 20] });
    const b = ball([0, 0, 0], [0, 0, 0], { massOverride: 3 });
    const w = await worldOf([z, b], SPACE);
    run(w, 1);
    expect(w.getPose(b.id)!.linvel[0]).toBeCloseTo(2 * (1 - DT), 3);
  });

  it('zone axes turn with the zone', async () => {
    const q: Quat = qfromAxisAngle([0, 0, 1], Math.PI / 2);
    const z = zoneBody({ action: 'force', force: [4, 0, 0] }, { rotation: q, size: [20, 20, 20] });
    const b = ball([0, 0, 0]);
    const w = await worldOf([z, b], SPACE);
    run(w, 0.5);
    near(w.getPose(b.id)!.linvel, [0, 4 * (0.5 - DT), 0], 3);
    const expected = qrot(q, [4, 0, 0]);
    expect(expected[1]).toBeCloseTo(4, 9);
  });

  it('toward the centre with no falloff: constant acceleration, v = a·t', async () => {
    const z = zoneBody(
      { action: 'force', forceMode: 'attract', strength: 2, falloff: 'none' },
      { shape: 'sphere', size: [20, 20, 20] },
    );
    const b = ball([4, 0, 0]);
    const w = await worldOf([z, b], SPACE);
    run(w, 0.5);
    expect(w.getPose(b.id)!.linvel[0]).toBeCloseTo(-2 * (0.5 - DT), 3);
  });

  it('linear falloff fades to nothing at the zone’s radius; repel pushes the other way', async () => {
    // radius 5: at r = 3 the strength is 2·(1 − 3/5) = 0.8
    const mk = async (mode: string) => {
      const z = zoneBody(
        { action: 'force', forceMode: mode, strength: 2, falloff: 'linear' },
        { shape: 'sphere', size: [10, 10, 10] },
      );
      const b = ball([3, 0, 0]);
      const w = await worldOf([z, b], SPACE);
      w.stepOnce(); // the zone has not noticed the body yet
      w.stepOnce();
      return w.getPose(b.id)!.linvel[0];
    };
    expect(await mk('attract')).toBeCloseTo(-0.8 / 120, 5);
    expect(await mk('repel')).toBeCloseTo(0.8 / 120, 5);
  });

  it('inverse square: the pull at the radius is the strength, and at twice the radius’ fraction it is four times that', async () => {
    const mk = async (x: number) => {
      const z = zoneBody(
        { action: 'force', forceMode: 'attract', strength: 1, falloff: 'inverse' },
        { shape: 'sphere', size: [10, 10, 10] }, // R = 5
      );
      const b = ball([x, 0, 0]);
      const w = await worldOf([z, b], SPACE);
      w.stepOnce();
      w.stepOnce();
      return -w.getPose(b.id)!.linvel[0] * 120;
    };
    expect(await mk(4.5)).toBeCloseTo((5 / 4.5) ** 2, 3);
    expect(await mk(2.5)).toBeCloseTo(4, 3); // r = R/2 → (R/r)² = 4
  });
});

describe('teleport', () => {
  it('to a world position: the body arrives there (and can be stopped)', async () => {
    const z = zoneBody({ action: 'teleport', offset: [0, 10, 0], velocity: 'stop' }, { size: [4, 4, 4] });
    const b = ball([0, 0, 0], [3, 0, 0]);
    const w = await worldOf([z, b], SPACE);
    run(w, 0.1);
    near(at(w, b.id), [0, 10, 0], 6);
    near(w.getPose(b.id)!.linvel, [0, 0, 0], 6);
    const ev = zoneEvents(w, 'teleport');
    expect(ev).toHaveLength(1);
    expect(ev[0].data).toMatchObject({ body: b.id, to: [0, 10, 0] });
  });

  it('to a target body, offset in the target’s frame; the velocity is kept', async () => {
    const marker = createBody({
      shape: { type: 'box', size: [1, 1, 1] },
      bodyType: 'static',
      ghost: true,
      position: [20, 5, 0],
    });
    const z = zoneBody({ action: 'teleport', target: marker.id, offset: [0, 2, 0] }, { size: [4, 4, 4] });
    const b = ball([0, 0, 0], [0, 0, 6]);
    const w = await worldOf([z, marker, b], SPACE);
    run(w, 0.02); // one or two steps after the move: still next to the destination
    const p = at(w, b.id);
    expect(p[0]).toBeCloseTo(20, 3);
    expect(p[1]).toBeCloseTo(7, 3);
    expect(w.getPose(b.id)!.linvel[2]).toBeCloseTo(6, 6);
  });

  it('“turn with the portal”: velocity and orientation follow the angle between the zone and its target', async () => {
    const q = qfromAxisAngle([0, 1, 0], Math.PI / 2); // the target faces 90° away about y
    const marker = createBody({
      shape: { type: 'box', size: [1, 1, 1] },
      bodyType: 'static',
      ghost: true,
      position: [20, 0, 0],
      rotation: q,
    });
    const z = zoneBody(
      { action: 'teleport', target: marker.id, velocity: 'rotate', orientation: 'rotate' },
      { size: [4, 4, 4] },
    );
    const b = ball([0, 0, 0], [10, 0, 0]);
    const w = await worldOf([z, marker, b], SPACE);
    w.stepOnce();
    // +x turned 90° about y is −z
    near(w.getPose(b.id)!.linvel, [0, 0, -10], 4);
    const r = w.getPose(b.id)!.rotation;
    expect(Math.abs(r[1])).toBeCloseTo(Math.SQRT1_2, 3); // a 90° turn about y
  });

  it('“match the target” sets the body’s orientation to the target’s', async () => {
    const q = qfromAxisAngle([1, 0, 0], 1.0);
    const marker = createBody({
      shape: { type: 'box', size: [1, 1, 1] },
      bodyType: 'static',
      ghost: true,
      position: [20, 0, 0],
      rotation: q,
    });
    const z = zoneBody(
      { action: 'teleport', target: marker.id, orientation: 'match', velocity: 'stop' },
      { size: [4, 4, 4] },
    );
    const b = ball([0, 0, 0]);
    const w = await worldOf([z, marker, b], SPACE);
    w.stepOnce();
    near(w.getPose(b.id)!.rotation, q, 5);
  });

  it('“same place in the target” keeps the offset inside the portal', async () => {
    const marker = createBody({
      shape: { type: 'box', size: [1, 1, 1] },
      bodyType: 'static',
      ghost: true,
      position: [20, 0, 0],
    });
    const z = zoneBody(
      { action: 'teleport', target: marker.id, mapping: 'relative', velocity: 'stop' },
      { size: [8, 8, 8] },
    );
    const b = ball([1.5, -2, 0.5]);
    const w = await worldOf([z, marker, b], SPACE);
    w.stepOnce();
    near(at(w, b.id), [21.5, -2, 0.5], 5);
  });

  it('a pair of teleporters does not bounce the body back and forth: the arrival is ignored for at least half a second', async () => {
    const markA = createBody({
      shape: { type: 'box', size: [1, 1, 1] },
      bodyType: 'static',
      ghost: true,
      position: [0, 0, 0],
    });
    const markB = createBody({
      shape: { type: 'box', size: [1, 1, 1] },
      bodyType: 'static',
      ghost: true,
      position: [20, 0, 0],
    });
    const a = zoneBody({ action: 'teleport', target: markB.id }, { position: [0, 0, 0], size: [4, 4, 4], name: 'A' });
    const bz = zoneBody({ action: 'teleport', target: markA.id }, { position: [20, 0, 0], size: [4, 4, 4], name: 'B' });
    const b = ball([-1, 0, 0], [2, 0, 0]);
    const w = await worldOf([a, bz, markA, markB, b], SPACE);
    const ev = runCollect(w, 0.5).filter((e) => e.name === 'teleport');
    expect(ev).toHaveLength(1);
    expect(ev[0].owner).toBe(a.id);
    // after the immunity ran out the body is still in B (it moves at 2 m/s) and nothing more happens until it re-enters
    expect(at(w, b.id)[0]).toBeGreaterThan(19);
  });

  it('a group teleports rigidly: the bodies keep their places relative to each other, turned with the orientation', async () => {
    const z = zoneBody(
      { action: 'teleport', offset: [50, 0, 0], unit: 'group', orientation: 'match', velocity: 'stop' },
      { size: [30, 4, 4] },
    );
    const front = ball([2, 0, 0], [0, 0, 0], { parent: 'car' });
    const rear = ball([-2, 0, 0], [0, 0, 0], { parent: 'car' });
    const w = await worldOf([z, front, rear], SPACE);
    w.stepOnce();
    // the entering body (the older one: `front`) lands on the point; `rear` keeps its 4 m offset behind it
    const f = at(w, front.id);
    const r = at(w, rear.id);
    expect(f[0] - r[0]).toBeCloseTo(4, 4);
    expect(Math.abs(f[0] - 50)).toBeLessThan(4.1);
    expect(zoneEvents(w, 'teleport')).toHaveLength(1);
  });
});

describe('kill zones', () => {
  it('“remove”: the body is switched off and a kill event names the cause', async () => {
    const z = zoneBody({ action: 'kill' }, { position: [5, 0, 0], size: [2, 4, 4] });
    const b = ball([0, 0, 0], [10, 0, 0]);
    const w = await worldOf([z, b], SPACE);
    const ev = runCollect(w, 1);
    expect(isOff(w, b.id)).toBe(true);
    const kill = ev.find((e) => e.name === 'kill')!;
    expect(kill.data).toMatchObject({ body: b.id, mode: 'remove', cause: 'zone', penalty: 0 });
  });

  it('“respawn at the start”: back at the authored pose with the authored velocity, after the delay', async () => {
    const z = zoneBody(
      { action: 'kill', killMode: 'respawn', respawnTo: 'start', respawnDelay: 0.25 },
      { position: [5, 0, 0], size: [2, 12, 12] },
    );
    const b = ball([1, 2, 3], [10, 0, 0]);
    const w = await worldOf([z, b], SPACE);
    runUntil(w, 'kill', 2);
    expect(isOff(w, b.id)).toBe(true); // held out during the delay
    run(w, 0.2);
    expect(isOff(w, b.id)).toBe(true);
    const back = runUntil(w, 'respawn', 0.2);
    expect(back).not.toBeNull();
    expect(back!.data).toMatchObject({ body: b.id, to: 'start', count: 1 });
    expect(isOff(w, b.id)).toBe(false);
    near(w.getPose(b.id)!.linvel, [10, 0, 0], 4);
    expect(at(w, b.id)[1]).toBeCloseTo(2, 5);
  });

  it('“respawn at the last checkpoint”: the pose the body had when it passed the checkpoint; the start when it passed none', async () => {
    const cp = zoneBody(
      { action: 'checkpoint', race: 'r', index: 1 },
      { position: [3, 0, 0], size: [1, 4, 4], name: 'cp' },
    );
    const kill = zoneBody(
      { action: 'kill', killMode: 'respawn', respawnTo: 'checkpoint' },
      { position: [8, 0, 0], size: [1, 4, 4], name: 'kill' },
    );
    const b = ball([0, 0.5, 0], [10, 0, 0]);
    const w = await worldOf([cp, kill, b], SPACE);
    // pose at the moment the checkpoint is passed
    expect(runUntil(w, 'checkpoint', 1)).not.toBeNull();
    const atCheckpoint = at(w, b.id);
    const back = runUntil(w, 'respawn', 1);
    expect(back!.data).toMatchObject({ to: 'checkpoint' });
    near(at(w, b.id), atCheckpoint, 5);
    near(w.getPose(b.id)!.linvel, [0, 0, 0], 6);

    // no checkpoint on the way: falls back to the start
    const w2 = await worldOf([kill, ball([0, 0.5, 0], [10, 0, 0])], SPACE);
    const r2 = runUntil(w2, 'respawn', 1);
    expect(r2!.data).toMatchObject({ to: 'start' });
  });

  it('a respawn limit turns the last one into a removal', async () => {
    const z = zoneBody(
      { action: 'kill', killMode: 'respawn', respawnTo: 'start', maxRespawns: 1 },
      { position: [5, 0, 0], size: [2, 4, 4] },
    );
    const b = ball([0, 0, 0], [10, 0, 0]);
    const w = await worldOf([z, b], SPACE);
    const modes = runCollect(w, 3)
      .filter((e) => e.name === 'kill')
      .map((e) => (e.data as { mode: string }).mode);
    expect(modes).toEqual(['respawn', 'remove']);
    expect(isOff(w, b.id)).toBe(true);
  });

  it('a vehicle is lost and brought back as a whole group', async () => {
    const z = zoneBody(
      { action: 'kill', killMode: 'respawn', respawnTo: 'start', unit: 'group' },
      { position: [5, 0, 0], size: [2, 4, 4] },
    );
    const chassis = ball([0, 0, 0], [10, 0, 0], { parent: 'car' });
    const wheel = ball([-1, 0, 2], [0, 0, 0], { parent: 'car' });
    const w = await worldOf([z, chassis, wheel], SPACE);
    expect(runUntil(w, 'respawn', 2)).not.toBeNull();
    expect(isOff(w, wheel.id)).toBe(false);
    near(at(w, wheel.id), [-1, 0, 2], 5);
  });

  it('a simulation-only body (a projectile) that is killed is deleted and the page is told; one that respawns returns to where it was fired', async () => {
    const z = zoneBody({ action: 'kill', killMode: 'remove' }, { position: [5, 0, 0], size: [2, 12, 12] });
    const w = await worldOf([z], SPACE);
    const shot = ball([0, 0, 0], [10, 0, 0]);
    w.addBody(shot, true);
    const ev = runCollect(w, 1);
    expect(w.bodyIds).not.toContain(shot.id);
    expect(ev.find((e) => e.name === 'despawn')?.data).toMatchObject({ body: shot.id, reason: 'kill' });

    const zr = zoneBody(
      { action: 'kill', killMode: 'respawn', respawnTo: 'start' },
      { position: [5, 0, 0], size: [2, 12, 12] },
    );
    const w2 = await worldOf([zr], SPACE);
    const shot2 = ball([1, 1, 0], [10, 0, 0]);
    w2.addBody(shot2, true);
    expect(runUntil(w2, 'respawn', 2)).not.toBeNull();
    expect(w2.bodyIds).toContain(shot2.id);
    expect(at(w2, shot2.id)[1]).toBeCloseTo(1, 5);
  });
});

describe('respawn points', () => {
  it('a respawn-point zone sets where a lost body comes back, and can move it there now', async () => {
    const pad = zoneBody(
      { action: 'respawnAt', offset: [0, 7, 0], moveNow: false },
      { position: [3, 0, 0], size: [1, 4, 4], name: 'pad' },
    );
    const kill = zoneBody(
      { action: 'kill', killMode: 'respawn', respawnTo: 'checkpoint' },
      { position: [8, 0, 0], size: [1, 4, 4] },
    );
    const b = ball([0, 0.5, 0], [10, 0, 0]);
    const w = await worldOf([pad, kill, b], SPACE);
    const back = runUntil(w, 'respawn', 2);
    expect(back!.data).toMatchObject({ to: 'checkpoint' });
    expect(at(w, b.id)[1]).toBeCloseTo(7, 5);

    const now = zoneBody(
      { action: 'respawnAt', offset: [0, 7, 0], moveNow: true },
      { position: [3, 0, 0], size: [1, 4, 4] },
    );
    const w2 = await worldOf([now, ball([0, 0.5, 0], [10, 0, 0])], SPACE);
    expect(runUntil(w2, 'teleport', 2)).not.toBeNull();
  });
});

describe('spawner', () => {
  const template = () => ball([30, 0, 0], [0, 0, 0], { name: 'Crate', tags: ['crate'] });

  it('copies the template when a body enters: at the zone’s offset, with the given velocity, and the original leaves the scene', async () => {
    const tpl = template();
    const z = zoneBody(
      { action: 'spawn', template: tpl.id, spawnOffset: [0, 3, 0], spawnVelocity: [0, 0, 2] },
      { position: [0, 0, 0], size: [4, 4, 4] },
    );
    const trigger = ball([0, 0, 0]);
    const w = await worldOf([z, tpl, trigger], SPACE);
    w.stepOnce();
    const ev = zoneEvents(w, 'spawn');
    expect(ev).toHaveLength(1);
    const def = (ev[0].data as { def: { id: string; name: string; tags: string[] } }).def;
    expect(def.name).toBe('Crate');
    expect(def.tags).toEqual(['crate']);
    expect(w.bodyIds).toContain(def.id);
    expect(isOff(w, tpl.id)).toBe(true); // the pattern is hidden
    run(w, 0.5);
    const p = w.getPose(def.id)!;
    expect(p.position[1]).toBeCloseTo(3, 1);
    expect(p.linvel[2]).toBeCloseTo(2, 3);
  });

  it('keeps the template when asked, and never spawns without one', async () => {
    const tpl = template();
    const z = zoneBody({ action: 'spawn', template: tpl.id, consume: false });
    const w = await worldOf([z, tpl, ball([0, 0, 0])], SPACE);
    run(w, 0.1);
    expect(isOff(w, tpl.id)).toBe(false);
    const none = zoneBody({ action: 'spawn', template: '' });
    const w2 = await worldOf([none, ball([0, 0, 0])], SPACE);
    run(w2, 0.1);
    expect(zoneEvents(w2, 'spawn')).toEqual([]);
  });

  it('at a steady rate: one copy per interval, up to the number alive', async () => {
    const tpl = template();
    const z = zoneBody(
      { action: 'spawn', template: tpl.id, when: 'timer', interval: 0.5, maxAlive: 3 },
      { size: [2, 2, 2] },
    );
    const w = await worldOf([z, tpl], SPACE);
    const events = runCollect(w, 2.3).filter((e) => e.name === 'spawn');
    expect(events).toHaveLength(3); // t = 0.5, 1.0, 1.5; the 4th would exceed maxAlive
    events.forEach((e, i) => expect(Math.abs(e.t - 0.5 * (i + 1))).toBeLessThan(2 * DT));
    expect((events[2].data as { alive: number }).alive).toBe(3);
  });

  it('copies live for `lifetime` seconds, then are removed (and the page is told); the spawner keeps going', async () => {
    const tpl = template();
    const z = zoneBody(
      { action: 'spawn', template: tpl.id, when: 'timer', interval: 0.5, maxAlive: 2, lifetime: 0.75 },
      { size: [2, 2, 2] },
    );
    const w = await worldOf([z, tpl], SPACE);
    const ev = runCollect(w, 3);
    const spawned = ev.filter((e) => e.name === 'spawn');
    const gone = ev.filter((e) => e.name === 'despawn');
    expect(spawned.length).toBeGreaterThanOrEqual(5);
    expect(gone.length).toBeGreaterThanOrEqual(4);
    expect(gone[0].data).toMatchObject({ reason: 'lifetime' });
    expect(w.bodyIds.length).toBeLessThanOrEqual(4); // zone, the (switched-off) template and at most 2 copies
  });

  it('several triggers at once spawn at most `maxAlive` copies', async () => {
    const tpl = template();
    const z = zoneBody({ action: 'spawn', template: tpl.id, maxAlive: 2 }, { size: [20, 4, 4] });
    const triggers = [-4, -2, 0, 2, 4].map((x) => ball([x, 0, 0]));
    const w = await worldOf([z, tpl, ...triggers], SPACE);
    run(w, 0.1);
    expect(zoneEvents(w, 'spawn')).toHaveLength(2);
  });

  it('copies get ids of their own, and their components are renamed', async () => {
    const tpl = ball([30, 0, 0], [0, 0, 0], { components: [makeComponent('constantForce', { force: [1, 0, 0] })] });
    const z = zoneBody({ action: 'spawn', template: tpl.id, when: 'timer', interval: 0.2, maxAlive: 5 });
    const w = await worldOf([z, tpl], SPACE);
    const ev = runCollect(w, 1).filter((e) => e.name === 'spawn');
    const defs = ev.map((e) => (e.data as { def: { id: string; components: { id: string }[] } }).def);
    expect(new Set(defs.map((d) => d.id)).size).toBe(defs.length);
    const compIds = defs.flatMap((d) => d.components.map((c) => c.id));
    expect(new Set(compIds).size).toBe(compIds.length);
    expect(compIds).not.toContain(tpl.components[0].id);
    // the copy's constant force works: it speeds up along +x
    const first = defs[0].id;
    expect(w.getPose(first)!.linvel[0]).toBeGreaterThan(0.3);
  });
});

describe('sound, score and label, custom events', () => {
  it('a sound zone raises a sound event with its sound, volume and pitch at the zone', async () => {
    const z = zoneBody(
      { action: 'sound', sound: 'boing', volume: 0.4, pitch: 1.5 },
      { position: [5, 1, 0], size: [2, 4, 4] },
    );
    const w = await worldOf([z, ball([0, 1, 0], [10, 0, 0])], SPACE);
    const ev = runCollect(w, 1).filter((e) => e.name === 'sound');
    expect(ev).toHaveLength(1);
    expect(ev[0].data).toMatchObject({ sound: 'boing', volume: 0.4, pitch: 1.5, at: [5, 1, 0] });
  });

  it('score zones add up (negative takes away), per racer and in total, and show their message', async () => {
    const coin = zoneBody({ action: 'score', points: 10, message: 'Coin!' }, { position: [2, 0, 0], size: [1, 4, 4] });
    const trap = zoneBody({ action: 'score', points: -3 }, { position: [4, 0, 0], size: [1, 4, 4] });
    const b = ball([0, 0, 0], [10, 0, 0]);
    const w = await worldOf([coin, trap, b], SPACE);
    run(w, 1);
    const state = w.drainComponentState().changed[ZONES_STATE_ID].json as ZonesPublic;
    expect(state.score.total).toBe(7);
    expect(state.score.byRacer[b.id]).toBe(7);
    expect(state.message).toMatchObject({ text: 'Coin!' });
  });

  it('a one-shot coin: with max triggers 1 only the first body gets the points', async () => {
    const coin = zoneBody({ action: 'score', points: 10, maxTriggers: 1 }, { size: [20, 4, 4] });
    const w = await worldOf([coin, ball([-3, 0, 0]), ball([3, 0, 0])], SPACE);
    run(w, 0.1);
    const state = w.drainComponentState().changed[ZONES_STATE_ID].json as ZonesPublic;
    expect(state.score.total).toBe(10);
  });

  it('a custom event carries its name and payload for logic and scripts', async () => {
    const z = zoneBody({ action: 'custom', customEvent: 'door_open', payload: '{"floor":2}', label: 'Button' });
    const w = await worldOf([z, ball([0, 0, 0])], SPACE);
    run(w, 0.05);
    const ev = zoneEvents(w, 'custom');
    expect(ev).toHaveLength(1);
    expect(ev[0].data).toMatchObject({ event: 'door_open', payload: '{"floor":2}', zone: 'Button', phase: 'enter' });
  });
});

describe('enable / disable components', () => {
  const fan = () =>
    ball([0, 0, 20], [0, 0, 0], {
      name: 'Fan',
      canSleep: false,
      components: [makeComponent('constantForce', { force: [10, 0, 0] })],
    });

  it('switches the components of another body off for the running simulation', async () => {
    const f = fan();
    const z = zoneBody(
      { action: 'toggle', target: f.id, componentType: 'constantForce', switchTo: 'disable' },
      { size: [4, 4, 4] },
    );
    const trigger = ball([0, 0, 0]);
    const w = await worldOf([z, f, trigger], SPACE);
    run(w, 1);
    // the force acted for one step only: v = (10 N / 1 kg)·dt
    expect(w.getPose(f.id)!.linvel[0]).toBeCloseTo(10 / 120, 4);
    const ev = zoneEvents(w, 'toggle');
    expect(ev[0].data).toMatchObject({ target: f.id, componentType: 'constantForce', enabled: false, changed: 1 });
  });

  it('“undo on exit” puts the components back when the last body leaves', async () => {
    const f = fan();
    const z = zoneBody(
      { action: 'toggle', target: f.id, switchTo: 'disable', revertOnExit: true },
      { position: [5, 0, 0], size: [2, 4, 4] },
    );
    const w = await worldOf([z, f, ball([0, 0, 0], [10, 0, 0])], SPACE);
    const off = runUntil(w, 'toggle', 2)!;
    expect(off.data).toMatchObject({ enabled: false });
    const vOff = w.getPose(f.id)!.linvel[0];
    expect(vOff).toBeGreaterThan(3); // it had been pushing for ≈ 0.4 s
    run(w, 0.1); // the trigger is still inside
    expect(w.getPose(f.id)!.linvel[0]).toBeCloseTo(vOff, 6);
    const on = runUntil(w, 'toggle', 2)!;
    expect(on.data).toMatchObject({ enabled: true });
    run(w, 0.5);
    expect(w.getPose(f.id)!.linvel[0]).toBeGreaterThan(vOff + 4.9); // back on: +10 N / 1 kg for 0.5 s
  });

  it('“toggle” switches whatever state the components are in', async () => {
    const f = fan();
    const z = zoneBody({ action: 'toggle', target: f.id, switchTo: 'toggle' }, { size: [4, 4, 4] });
    const w = await worldOf([z, f, ball([0, 0, 0])], SPACE);
    run(w, 0.1);
    expect(zoneEvents(w, 'toggle')[0].data).toMatchObject({ enabled: false });
  });

  it('“every component” leaves zones alone; naming a zone switches it', async () => {
    const other = zoneBody({ action: 'score', points: 1 }, { position: [30, 0, 0], size: [2, 2, 2] });
    const z = zoneBody({ action: 'toggle', target: other.id, switchTo: 'disable' }, { size: [4, 4, 4] });
    const w = await worldOf([z, other, ball([0, 0, 0])], SPACE);
    run(w, 0.1);
    expect(w.isComponentRunning(other.components[0].id)).toBe(true);
    const z2 = zoneBody(
      { action: 'toggle', target: other.id, componentType: 'zone', switchTo: 'disable' },
      { size: [4, 4, 4] },
    );
    const w2 = await worldOf([z2, other, ball([0, 0, 0])], SPACE);
    run(w2, 0.1);
    expect(w2.isComponentRunning(other.components[0].id)).toBe(false);
  });
});
