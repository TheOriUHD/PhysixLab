/**
 * Package ED-B interaction tools without a DOM: blast variants and falloff curves (ED-40), the throw / aim flight
 * prediction and projectile types (ED-44), grab strength / spin / freeze / throw scale in the real engine (ED-45),
 * and the registrations of the paint, pin and option-bar tools (ED-42, ED-43).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app/app';
import { registerAppBuiltins } from '../src/app/builtin';
import { chargePower } from '../src/app/projectiles';
import { PrefsStore } from '../src/app/prefs';
import { projectileRecipe, PROJECTILE_TYPES } from '../src/app/projectileTypes';
import { getCommand } from '../src/app/registry/commands';
import { keymap } from '../src/app/registry/keymap';
import { getTool } from '../src/app/registry/tools';
import { optionsForMode } from '../src/app/toolOptions';
import { predictFlight } from '../src/app/trajectory';
import { vlen, type Vec3 } from '../src/core/math';
import { SceneStore } from '../src/model/store';
import { registerUiBuiltins } from '../src/ui/builtin';
import { blastImpulse, BLAST_KINDS, falloffCurve, FALLOFF_KINDS } from '../src/physics/world/blast';
import { createBody, run, worldOf } from './helpers';

const free = { linearDamping: 0, angularDamping: 0, canSleep: false };
const zeroG = { gravity: [0, 0, 0] as Vec3 };
const noGround = { ground: { enabled: false, friction: 0.5, restitution: 0, halfSize: 50, color: '#000' } };
const ball = (over: Parameters<typeof createBody>[0] = {}) =>
  createBody({ shape: { type: 'sphere', size: [0.5, 0.5, 0.5] }, position: [0, 5, 0], ...free, ...over });

const base = { center: [0, 0, 0] as Vec3, dir: [1, 0, 0] as Vec3, strength: 40, radius: 10 };

describe('falloff curves', () => {
  it('are 1 at the centre, 0 at the edge and never increase with distance', () => {
    for (const k of FALLOFF_KINDS) {
      expect(falloffCurve(k, 0), k).toBe(1);
      expect(falloffCurve(k, 1), k).toBe(0);
      let prev = 1;
      for (let t = 0; t <= 1.0001; t += 0.05) {
        const v = falloffCurve(k, t);
        expect(v, `${k} @${t}`).toBeLessThanOrEqual(prev + 1e-12);
        prev = v;
      }
    }
  });

  it('have the analytic values at half the radius', () => {
    expect(falloffCurve('quadratic', 0.5)).toBeCloseTo(0.25, 12);
    expect(falloffCurve('linear', 0.5)).toBeCloseTo(0.5, 12);
    expect(falloffCurve('smooth', 0.5)).toBeCloseTo(0.5, 12);
    expect(falloffCurve('steep', 0.5)).toBeCloseTo(0.0625, 12);
    expect(falloffCurve('constant', 0.5)).toBe(1);
  });
});

describe('blast variants (pure maths)', () => {
  const at = (kind: (typeof BLAST_KINDS)[number], falloff: (typeof FALLOFF_KINDS)[number], com: Vec3, mass = 1) =>
    blastImpulse({ ...base, kind, falloff }, com, mass);

  it('radial: pushes away from the centre with the impulse (1-d/R)² · strength · m^(2/3) plus a small lift', () => {
    const e = at('radial', 'quadratic', [5, 0, 0], 8)!;
    const j = 40 * 0.25 * 4; // strength · falloff · m^(2/3)
    expect(e.impulse[0]).toBeCloseTo(j, 9);
    expect(e.impulse[1]).toBeCloseTo(j * 0.25, 9);
    expect(e.impulse[2]).toBeCloseTo(0, 9);
  });

  it('does not reach bodies outside the radius', () => {
    for (const k of BLAST_KINDS) expect(at(k, 'linear', [11, 0, 0]), k).toBeNull();
  });

  it('directional: pushes along the given direction whatever the side of the centre', () => {
    for (const com of [
      [3, 0, 0],
      [-3, 2, 1],
    ] as Vec3[]) {
      const e = at('directional', 'linear', com)!;
      expect(e.impulse[0]).toBeGreaterThan(0);
      expect(e.impulse[1]).toBeCloseTo(0, 12);
      expect(e.impulse[2]).toBeCloseTo(0, 12);
    }
  });

  it('implosion: pulls towards the centre, with no lift', () => {
    const e = at('implosion', 'linear', [0, 0, 4])!;
    expect(e.impulse[2]).toBeLessThan(0);
    expect(e.impulse[0]).toBeCloseTo(0, 12);
    expect(e.impulse[1]).toBeCloseTo(0, 12);
    expect(at('implosion', 'linear', [0, 0, 0])).toBeNull();
  });

  it('ring: strongest on the ring, nothing at the centre, mostly horizontal outwards', () => {
    const onRing = at('ring', 'linear', [6.5, 0, 0])!;
    const off = at('ring', 'linear', [4.5, 0, 0])!;
    expect(onRing.impulse[0]).toBeGreaterThan(off.impulse[0]);
    expect(onRing.impulse[0]).toBeCloseTo(40, 9);
    expect(onRing.impulse[1]).toBeCloseTo(10, 9);
    expect(at('ring', 'linear', [0.2, 0, 0])).toBeNull();
    expect(at('ring', 'linear', [9.9, 0, 0])).toBeNull();
  });

  it('a lighter body gets less impulse than a heavier one (area scaling) but a larger velocity change', () => {
    const light = at('radial', 'linear', [3, 0, 0], 1)!;
    const heavy = at('radial', 'linear', [3, 0, 0], 8)!;
    expect(heavy.impulse[0] / light.impulse[0]).toBeCloseTo(4, 9);
    expect(light.impulse[0] / 1).toBeGreaterThan(heavy.impulse[0] / 8);
  });
});

describe('blast variants in the engine', () => {
  it('a directional blast along +z moves a body at the centre along +z and nothing else', async () => {
    const b = ball({ position: [1, 0, 0] });
    const w = await worldOf([b], { ...zeroG, ...noGround });
    w.applyOp({
      op: 'explode',
      center: [0, 0, 0],
      strength: 30,
      radius: 7,
      kind: 'directional',
      falloff: 'linear',
      dir: [0, 0, 1],
    });
    w.stepOnce();
    const v = w.getPose(b.id)!.linvel;
    expect(v[2]).toBeGreaterThan(0.5);
    expect(Math.abs(v[0])).toBeLessThan(1e-6);
    expect(Math.abs(v[1])).toBeLessThan(1e-6);
  });

  it('an implosion pulls a body towards the centre; the old op without options still pushes it away', async () => {
    const a = ball({ position: [3, 0, 0] });
    const w = await worldOf([a], { ...zeroG, ...noGround });
    w.applyOp({ op: 'explode', center: [0, 0, 0], strength: 30, radius: 7, kind: 'implosion', falloff: 'linear' });
    w.stepOnce();
    expect(w.getPose(a.id)!.linvel[0]).toBeLessThan(-0.5);
    const c = ball({ position: [3, 0, 0] });
    const w2 = await worldOf([c], { ...zeroG, ...noGround });
    w2.applyOp({ op: 'explode', center: [0, 0, 0], strength: 30, radius: 7 });
    w2.stepOnce();
    expect(w2.getPose(c.id)!.linvel[0]).toBeGreaterThan(0.5);
  });

  it('the falloff curve changes how far the push reaches: constant is as strong at 90 % of the radius as at 10 %', async () => {
    const near = ball({ position: [0.7, 0, 0] });
    const far = ball({ position: [0, 0, 6.3] });
    const w = await worldOf([near, far], { ...zeroG, ...noGround });
    w.applyOp({
      op: 'explode',
      center: [0, 0, 0],
      strength: 20,
      radius: 7,
      kind: 'directional',
      falloff: 'constant',
      dir: [0, 1, 0],
    });
    w.stepOnce();
    expect(w.getPose(near.id)!.linvel[1]).toBeCloseTo(w.getPose(far.id)!.linvel[1], 6);
    const n2 = ball({ position: [0.7, 0, 0] });
    const f2 = ball({ position: [0, 0, 6.3] });
    const w2 = await worldOf([n2, f2], { ...zeroG, ...noGround });
    w2.applyOp({
      op: 'explode',
      center: [0, 0, 0],
      strength: 20,
      radius: 7,
      kind: 'directional',
      falloff: 'steep',
      dir: [0, 1, 0],
    });
    w2.stepOnce();
    expect(w2.getPose(n2.id)!.linvel[1]).toBeGreaterThan(5 * w2.getPose(f2.id)!.linvel[1]);
  });
});

describe('throw / aim flight prediction and projectile types', () => {
  it('in vacuum follows the textbook parabola: range v²·sin(2θ)/g', () => {
    const v = 20,
      th = Math.PI / 4;
    const f = predictFlight({
      origin: [0, 0.001, 0],
      velocity: [v * Math.cos(th), v * Math.sin(th), 0],
      gravity: [0, -9.81, 0],
      gravityScale: 1,
      damping: 0,
      dt: 1 / 240,
      maxTime: 10,
    });
    expect(f.landing).not.toBeNull();
    expect(f.landing![0]).toBeCloseTo((v * v * Math.sin(2 * th)) / 9.81, 0);
    expect(f.time).toBeCloseTo((2 * v * Math.sin(th)) / 9.81, 1);
  });

  it('drag shortens the flight', () => {
    const args = {
      origin: [0, 1, 0] as Vec3,
      velocity: [20, 10, 0] as Vec3,
      gravity: [0, -9.81, 0] as Vec3,
      gravityScale: 1,
    };
    const a = predictFlight({ ...args, damping: 0 }).landing![0];
    const b = predictFlight({ ...args, damping: 0.5 }).landing![0];
    expect(b).toBeLessThan(a * 0.9);
  });

  it('matches the real engine: the predicted position after 1 s is within 10 cm of the simulated one', async () => {
    const damping = 0.3;
    const b = ball({ position: [0, 3, 0], linearDamping: damping, velocity: [12, 6, -2], ccd: true });
    const w = await worldOf([b], { ...noGround });
    const gravity: Vec3 = [0, -9.81, 0];
    run(w, 1);
    const sim = w.getPose(b.id)!.position;
    const f = predictFlight({
      origin: [0, 3, 0],
      velocity: [12, 6, -2],
      gravity,
      gravityScale: 1,
      damping,
      floorY: null,
      maxTime: 1,
      dt: 1 / 120,
    });
    const n = f.points.length / 3 - 1;
    const last = f.points.slice(n * 3, n * 3 + 3);
    // The preview integrates like the engine to within a few centimetres over a 13 m path (the engine orders the
    // damping / integration substeps slightly differently).
    for (let i = 0; i < 3; i++) expect(Math.abs(last[i] - sim[i]), `axis ${i}`).toBeLessThan(0.1);
  });

  it('charge: a tap is 1×, holding builds up to 2.5× and no more', () => {
    expect(chargePower(0)).toBe(1);
    expect(chargePower(150)).toBe(1);
    expect(chargePower(180 + 750)).toBeCloseTo(1.75, 9);
    expect(chargePower(10_000)).toBe(2.5);
  });

  it('every projectile type builds a body of the intended mass in the real engine', async () => {
    expect(PROJECTILE_TYPES.map((t) => t.id)).toEqual(['ball', 'bowling', 'bomb', 'bullet', 'crate', 'heavy', 'dart']);
    for (const t of PROJECTILE_TYPES) {
      const r = projectileRecipe(t, 0.4, 28, 0);
      const body = createBody({
        ...r.init,
        position: [0, 5, 0],
        ...(r.mass !== null ? { massOverride: r.mass } : {}),
      });
      const w = await worldOf([body], zeroG);
      const mass = w.builtInfo().mass[body.id];
      if (r.mass !== null) expect(mass, t.id).toBeCloseTo(r.mass, 3);
      else expect(mass, t.id).toBeGreaterThan(100); // the plain steel ball keeps density × volume
    }
    // the mass option overrides the type's mass
    expect(projectileRecipe(PROJECTILE_TYPES[1], 0.4, 28, 50).mass).toBe(50);
    // speeds: bullets are the fastest, heavy balls the slowest
    const speed = (id: string) =>
      projectileRecipe(
        PROJECTILE_TYPES.find((t) => t.id === id)!,
        0.4,
        28,
        0,
      ).speed;
    expect(speed('bullet')).toBeGreaterThan(speed('ball'));
    expect(speed('heavy')).toBeLessThan(speed('ball'));
  });
});

describe('grab upgrades', () => {
  const held = async (strength: number) => {
    const b = ball({ position: [0, 0, 0], canSleep: false });
    const w = await worldOf([b], { ...zeroG, ...noGround });
    w.applyOp({ op: 'grab', id: b.id, point: [0, 0, 0], target: [4, 0, 0], strength });
    return { w, id: b.id };
  };

  it('a stronger grab pulls the body to the cursor faster', async () => {
    const weak = await held(0.25);
    const strong = await held(4);
    run(weak.w, 0.4);
    run(strong.w, 0.4);
    expect(strong.w.getPose(strong.id)!.position[0]).toBeGreaterThan(weak.w.getPose(weak.id)!.position[0] + 0.5);
  });

  it('grabSpin turns the held body at the requested rate; zero stops it', async () => {
    const { w, id } = await held(1);
    w.applyOp({ op: 'grabMove', target: [0, 0, 0] });
    w.applyOp({ op: 'grabSpin', angvel: [0, 3, 0] });
    run(w, 1.5);
    expect(w.getPose(id)!.angvel[1]).toBeGreaterThan(2);
    w.applyOp({ op: 'grabSpin', angvel: [0, 0, 0] });
    run(w, 1.5);
    expect(Math.abs(w.getPose(id)!.angvel[1])).toBeLessThan(0.3);
  });

  it('freeze pins the body in place against gravity and the grab; unfreeze gives it back its freedom', async () => {
    const b = ball({ position: [0, 5, 0], canSleep: false });
    const w = await worldOf([b], { ...noGround });
    w.applyOp({ op: 'grab', id: b.id, point: [0, 5, 0], target: [0, 5, 0] });
    run(w, 0.3);
    w.applyOp({ op: 'grabFreeze', frozen: true });
    w.applyOp({ op: 'release' });
    run(w, 1);
    expect(w.getPose(b.id)!.position[1]).toBeCloseTo(5, 2);
    expect(vlen(w.getPose(b.id)!.linvel)).toBeLessThan(1e-6);
    // grab again (a frozen body can be held) and toggle it off
    w.applyOp({ op: 'grab', id: b.id, point: [0, 5, 0], target: [0, 5, 0] });
    w.applyOp({ op: 'grabFreeze' });
    w.applyOp({ op: 'release' });
    run(w, 0.5);
    expect(w.getPose(b.id)!.position[1]).toBeLessThan(4.5);
  });

  it('release keeps the hand velocity by default, scales it with throwScale, and 0 drops the body dead', async () => {
    const result: number[] = [];
    for (const scale of [undefined, 2, 0]) {
      const { w, id } = await held(1);
      w.applyOp({ op: 'grabMove', target: [40, 0, 0] });
      run(w, 0.3);
      const before = w.getPose(id)!.linvel[0];
      expect(before).toBeGreaterThan(2);
      w.applyOp({ op: 'release', throwScale: scale });
      result.push(w.getPose(id)!.linvel[0] / before);
    }
    expect(result[0]).toBeCloseTo(1, 6);
    expect(result[1]).toBeCloseTo(2, 6);
    expect(result[2]).toBeCloseTo(0, 6);
  });
});

describe('ED-B tool registrations', () => {
  beforeAll(async () => {
    registerAppBuiltins();
    registerUiBuiltins();
    await import('../src/ui/extensions/edTools');
  });

  it('paint and pin are real tools with a command, a shortcut and a hint', () => {
    const app = { prefs: new PrefsStore(), sim: { active: false }, store: new SceneStore() } as unknown as App;
    for (const [id, key] of [
      ['paint', 'P'],
      ['pin', 'N'],
    ] as const) {
      const t = getTool(id)!;
      expect(t, id).toBeDefined();
      expect(t.pointerDown, id).toBeTypeOf('function');
      expect(t.hint!(app), id).toMatch(/\S/);
      const cmd = getCommand(`tool.${id}`)!;
      expect(cmd.shortcut, id).toEqual(key);
      expect(
        keymap.find({
          code: `Key${key}`,
          key: key.toLowerCase(),
          ctrlKey: false,
          metaKey: false,
          altKey: false,
          shiftKey: false,
        })?.id,
      ).toBe(`tool.${id}`);
    }
  });

  it('every interaction tool of the package has an options bar entry whose keys are real preferences', () => {
    const prefs = new PrefsStore().value;
    for (const mode of ['blast', 'shoot', 'paint', 'pin', 'select']) {
      const opts = optionsForMode(mode);
      expect(opts.length, mode).toBeGreaterThan(0);
      for (const o of opts) {
        expect(o.key in prefs, `${mode}.${o.key}`).toBe(true);
        if (o.kind === 'select')
          expect(
            o.options.some((x) => x.value === prefs[o.key]),
            `${mode}.${o.key} default`,
          ).toBe(true);
        if (o.kind === 'range') {
          const v = prefs[o.key] as unknown as number;
          expect(v >= o.min && v <= o.max, `${mode}.${o.key} default in range`).toBe(true);
        }
      }
    }
  });
});
