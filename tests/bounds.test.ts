/**
 * World bounds (ZN-34): kill box / kill plane, soft walls, open and water edges, the respawn policy — all against
 * analytic expectations in the real engine.
 */
import { describe, expect, it } from 'vitest';
import { defaultBounds, defaultSettings } from '../src/model/factory';
import type { BoundsSettings, SceneSettings } from '../src/model/types';
import { BOUNDS_EVENT_TYPE } from '../src/model/zones';
import { at, ball, eventsOf, isOff, run, SPACE, worldOf } from './zonesHelpers';
import { createBody } from './helpers';

const DT = 1 / 120;

/** A scene whose bounds are a ±10 m box (floor at −10) with the given overrides. */
const bounds = (over: Partial<BoundsSettings> = {}): Partial<SceneSettings> => ({
  ...SPACE,
  bounds: { ...defaultBounds(), enabled: true, min: [-10, -10, -10], max: [10, 10, 10], ...over },
});

describe('kill box', () => {
  it('loses a body whose centre crosses a face, at the time x = 10 is reached', async () => {
    const b = ball([0, 0, 0], [5, 0, 0]);
    const w = await worldOf([b], bounds());
    run(w, 1.9);
    expect(isOff(w, b.id)).toBe(false); // x = 9.5
    eventsOf(w, BOUNDS_EVENT_TYPE);
    run(w, 0.2); // passes x = 10 at t = 2 s
    expect(isOff(w, b.id)).toBe(true);
    const kill = eventsOf(w, BOUNDS_EVENT_TYPE, 'kill');
    expect(kill).toHaveLength(1);
    expect(kill[0].data).toMatchObject({ body: b.id, mode: 'remove', cause: 'bounds' });
    // the body was switched off the step after it crossed: within a step of the analytic time
    expect(at(w, b.id)[0]).toBeGreaterThan(10);
    expect(at(w, b.id)[0]).toBeLessThan(10 + 5 * 2 * DT);
  });

  it('every face of the box kills, and the policy is checked on dynamic bodies only', async () => {
    const dirs: [number, number, number][] = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    // start apart, on the faces' own axes, so the balls never touch each other
    const balls = dirs.map((d) => ball([d[0] * 2, d[1] * 2, d[2] * 2], [d[0] * 20, d[1] * 20, d[2] * 20]));
    const still = createBody({ shape: { type: 'box', size: [1, 1, 1] }, position: [50, 0, 0], bodyType: 'static' });
    const w = await worldOf([...balls, still], bounds());
    run(w, 0.8); // 16 m of travel
    for (const b of balls) expect(isOff(w, b.id)).toBe(true);
    expect(isOff(w, still.id)).toBe(false); // outside the box, but static bodies are not subject to bounds
  });

  it('does nothing while the bounds are disabled', async () => {
    const b = ball([0, 0, 0], [50, 0, 0]);
    const w = await worldOf([b], bounds({ enabled: false }));
    run(w, 1);
    expect(isOff(w, b.id)).toBe(false);
    expect(at(w, b.id)[0]).toBeCloseTo(50, 0);
  });

  it('open faces let bodies go; only the faces set to kill act', async () => {
    const edges = { ...defaultBounds().edges, px: 'open' as const };
    const out = ball([0, 0, 0], [20, 0, 0]);
    const lost = ball([0, 5, 0], [-20, 0, 0]);
    const w = await worldOf([out, lost], bounds({ edges }));
    run(w, 1);
    expect(isOff(w, out.id)).toBe(false);
    expect(at(w, out.id)[0]).toBeCloseTo(20, 0);
    expect(isOff(w, lost.id)).toBe(true);
  });
});

describe('kill plane and water edge', () => {
  const floorOnly = (edge: 'kill' | 'water') => ({
    nx: 'open' as const,
    px: 'open' as const,
    ny: edge,
    py: 'open' as const,
    nz: 'open' as const,
    pz: 'open' as const,
  });

  it('a body falling past the floor is lost when its centre reaches it: t = √(2h/g)', async () => {
    const b = ball([0, 5, 0]);
    const w = await worldOf([b], {
      gravity: [0, -9.81, 0],
      ground: { ...defaultSettings().ground, enabled: false },
      bounds: {
        ...defaultBounds(),
        enabled: true,
        min: [-100, 0, -100],
        max: [100, 100, 100],
        edges: floorOnly('kill'),
      },
    });
    const tFall = Math.sqrt((2 * 5) / 9.81); // 1.0096 s
    run(w, tFall - 0.05);
    expect(isOff(w, b.id)).toBe(false);
    run(w, 0.1);
    expect(isOff(w, b.id)).toBe(true);
  });

  it('a water edge drowns instead: same loss, reported with the cause "drowned"', async () => {
    const b = ball([0, 2, 0]);
    const w = await worldOf([b], {
      gravity: [0, -9.81, 0],
      ground: { ...defaultSettings().ground, enabled: false },
      bounds: {
        ...defaultBounds(),
        enabled: true,
        min: [-100, 0, -100],
        max: [100, 100, 100],
        edges: floorOnly('water'),
      },
    });
    run(w, 1);
    const ev = eventsOf(w, BOUNDS_EVENT_TYPE, 'kill');
    expect(ev).toHaveLength(1);
    expect(ev[0].data).toMatchObject({ body: b.id, cause: 'drowned' });
  });
});

describe('soft walls', () => {
  const soft = (stiffness: number, damping: number, margin = 3): Partial<SceneSettings> =>
    bounds({
      edges: { ...defaultBounds().edges, px: 'soft' },
      soft: { margin, stiffness, damping },
    });

  it('an undamped soft wall is a spring: a body at 5 m/s stops v/√k = 1 m into it and comes back at 5 m/s', async () => {
    const b = ball([0, 0, 0], [5, 0, 0]);
    const w = await worldOf([b], soft(25, 0)); // wall starts at x = 7 (margin 3), ω = 5 rad/s
    let maxX = -Infinity;
    let turned = false;
    for (let i = 0; i < 3 * 120; i++) {
      w.stepOnce();
      maxX = Math.max(maxX, at(w, b.id)[0]);
      if (w.getPose(b.id)!.linvel[0] < 0) turned = true;
    }
    expect(turned).toBe(true);
    expect(maxX).toBeGreaterThan(7.97);
    expect(maxX).toBeLessThan(8.05); // 7 + v/ω = 8, to within the integrator's error
    expect(isOff(w, b.id)).toBe(false);
    // after the bounce it is heading away at the speed it came with
    expect(w.getPose(b.id)!.linvel[0]).toBeLessThan(-4.9);
    expect(w.getPose(b.id)!.linvel[0]).toBeGreaterThan(-5.1);
  });

  it('damping takes energy from the outward motion: penetration and return speed follow the damped oscillator', async () => {
    const k = 25;
    const c = 4;
    const v0 = 5;
    const b = ball([0, 0, 0], [v0, 0, 0]);
    const w = await worldOf([b], soft(k, c));
    let maxX = -Infinity;
    for (let i = 0; i < 3 * 120; i++) {
      w.stepOnce();
      maxX = Math.max(maxX, at(w, b.id)[0]);
    }
    // x'' = −k·d − c·x' while moving outward (underdamped, ζ = c / 2ω); the inward half is undamped
    const om = Math.sqrt(k);
    const zeta = c / (2 * om);
    const wd = om * Math.sqrt(1 - zeta * zeta);
    const tStar = Math.atan(wd / (zeta * om)) / wd;
    const depth = (v0 / wd) * Math.exp(-zeta * om * tStar) * Math.sin(wd * tStar);
    expect(maxX - 7).toBeGreaterThan(depth * 0.97);
    expect(maxX - 7).toBeLessThan(depth * 1.03);
    expect(depth).toBeLessThan(0.7); // the undamped wall would go 1 m deep
    const vBack = w.getPose(b.id)!.linvel[0];
    expect(-vBack).toBeGreaterThan(om * depth * 0.96);
    expect(-vBack).toBeLessThan(om * depth * 1.04);
    expect(-vBack).toBeLessThan(v0 * 0.7); // energy was lost
  });

  it('a soft wall never loses a body, and other faces still kill', async () => {
    const hard = ball([0, 0, 0], [0, 30, 0]);
    const slow = ball([0, 0, 5], [12, 0, 0]);
    const w = await worldOf([hard, slow], soft(100, 8));
    run(w, 2);
    expect(isOff(w, slow.id)).toBe(false);
    expect(at(w, slow.id)[0]).toBeLessThan(10);
    expect(isOff(w, hard.id)).toBe(true); // +y is a kill face
  });

  it('a body at rest in the open middle of the box feels nothing', async () => {
    const b = ball([0, 0, 0]);
    const w = await worldOf([b], soft(25, 4));
    run(w, 1);
    expect(at(w, b.id)).toEqual([0, 0, 0]);
  });
});

describe('respawn policy', () => {
  const respawn = (r: Partial<BoundsSettings['respawn']> = {}): Partial<SceneSettings> =>
    bounds({ policy: 'respawn', respawn: { ...defaultBounds().respawn, to: 'start', ...r } });

  it('puts the body back at its authored pose with its authored velocity', async () => {
    const b = ball([1, 2, 3], [10, 0, 0]);
    const w = await worldOf([b], respawn());
    run(w, 1); // x = 1 + 10t crosses 10 at t = 0.9
    const ev = eventsOf(w, BOUNDS_EVENT_TYPE);
    expect(ev.map((e) => e.name)).toEqual(['kill', 'respawn']);
    expect(ev[1].data).toMatchObject({ body: b.id, to: 'start', cause: 'bounds', count: 1 });
    expect(isOff(w, b.id)).toBe(false);
    // it started again from (1, 2, 3) at 10 m/s, shortly after t = 0.9
    const p = w.getPose(b.id)!;
    expect(p.position[1]).toBeCloseTo(2, 6);
    expect(p.position[2]).toBeCloseTo(3, 6);
    expect(p.linvel[0]).toBeCloseTo(10, 4);
    expect(p.position[0]).toBeGreaterThan(1);
    expect(p.position[0]).toBeLessThan(2.5);
  });

  it('a delay holds the body out of the world, then returns it', async () => {
    const b = ball([0, 0, 0], [20, 0, 0]);
    const w = await worldOf([b], respawn({ delay: 0.5 })); // lost at t = 0.5
    run(w, 0.7);
    expect(isOff(w, b.id)).toBe(true);
    eventsOf(w, BOUNDS_EVENT_TYPE);
    run(w, 0.5);
    expect(isOff(w, b.id)).toBe(false);
    expect(eventsOf(w, BOUNDS_EVENT_TYPE, 'respawn')).toHaveLength(1);
  });

  it('gives up after `max` respawns and removes the body for good', async () => {
    const b = ball([0, 0, 0], [30, 0, 0]);
    const w = await worldOf([b], respawn({ max: 2 })); // lost every ≈ 0.33 s
    const kills: string[] = [];
    for (let i = 0; i < 4 * 120; i++) {
      w.stepOnce();
      for (const e of eventsOf(w, BOUNDS_EVENT_TYPE, 'kill')) kills.push((e.data as { mode: string }).mode);
    }
    expect(kills).toEqual(['respawn', 'respawn', 'remove']);
    expect(isOff(w, b.id)).toBe(true);
  });

  it('a simulation-only body (a projectile) is removed, never respawned', async () => {
    const w = await worldOf([ball([0, 0, 0])], respawn());
    const shot = ball([0, 0, 0], [30, 0, 0]);
    w.addBody(shot, true);
    run(w, 1);
    expect(w.bodyIds).not.toContain(shot.id);
  });

  it('respawns bodies of one group together when asked, and independently otherwise', async () => {
    const a = ball([0, 0, 0], [30, 0, 0], { parent: 'car' });
    const wheel = ball([0, 0, 5], [0, 0, 0], { parent: 'car' });
    const loose = ball([5, 0, -5], [0, 0, 0]);
    const w = await worldOf([a, wheel, loose], respawn({ wholeGroups: true }));
    run(w, 0.5);
    const ev = eventsOf(w, BOUNDS_EVENT_TYPE, 'respawn');
    expect(ev).toHaveLength(1);
    // the wheel was carried back too: still where it began (it never moved)
    expect(at(w, wheel.id)).toEqual([0, 0, 5]);
    expect(isOff(w, wheel.id)).toBe(false);
  });
});
