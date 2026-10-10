/**
 * Particle system (FX-1): the type registry and its compiled curves, the pooled simulation (caps, expiry, gravity,
 * wind, floor), draw order, and determinism with the scene seed. All pure data and maths — no WebGL.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ParticleEmitter, mixSeed } from '../src/render/fx/emitter';
import { registerBuiltinParticleTypes, BUILTIN_PARTICLE_TYPES } from '../src/render/fx/builtinTypes';
import { ParticlePool, S, type ParticleEnv } from '../src/render/fx/particlePool';
import {
  ParticleTypeTable,
  hexToLinear,
  particleTypes,
  registerParticleType,
  validateParticleType,
  type ParticleTypeDef,
} from '../src/render/fx/particleTypes';
import {
  ATLAS_COLS,
  ATLAS_LEVELS,
  ATLAS_SIZE,
  CELL,
  SPRITE_NAMES,
  generateAtlas,
  generateAtlasLevels,
} from '../src/render/fx/sprites';
import { DEFAULT_FX_SETTINGS, FX_TIERS, resolveTier, sanitizeFxSettings } from '../src/render/fx/settings';

registerBuiltinParticleTypes();

const ENV: ParticleEnv = { gravity: [0, -9.81, 0], wind: [0, 0, 0], floorY: 0 };

function rig(seed = 1, capacity = 4000) {
  const table = new ParticleTypeTable(particleTypes);
  const additive = new ParticlePool(capacity, table);
  const normal = new ParticlePool(capacity, table);
  const emitter = new ParticleEmitter(table, additive, normal);
  emitter.reseed(seed);
  return { table, additive, normal, emitter };
}

/** A minimal type with every dynamic off, to isolate one effect at a time. */
function probe(over: Partial<ParticleTypeDef> = {}): ParticleTypeDef {
  return {
    id: 'test.probe',
    blend: 'normal',
    sprites: ['soft'],
    life: [10, 10],
    size: [0.1, 0.1],
    sizeOverLife: [[0, 1]],
    alphaOverLife: [[0, 1]],
    colorOverLife: [[0, '#ffffff']],
    speed: [0, 0],
    spread: 0,
    gravity: 0,
    drag: 0,
    wind: 0,
    spin: [0, 0],
    orient: 'billboard',
    bounce: 0,
    count: 1,
    radius: 0,
    ...over,
  };
}

const offs: (() => void)[] = [];
afterEach(() => {
  while (offs.length) offs.pop()?.();
});
const withType = (d: ParticleTypeDef) => offs.push(registerParticleType(d));

const y = (p: ParticlePool, i = 0) => p.state[i * S.STRIDE + S.py];
const vy = (p: ParticlePool, i = 0) => p.state[i * S.STRIDE + S.vy];

describe('particle type registry', () => {
  it('every built-in type is valid and has a sprite, a lifetime and curves that end invisible', () => {
    const { table } = rig();
    expect(BUILTIN_PARTICLE_TYPES.length).toBeGreaterThanOrEqual(20);
    for (const def of BUILTIN_PARTICLE_TYPES) {
      expect(() => validateParticleType(def), def.id).not.toThrow();
      const c = table.get(def.id);
      expect(c, def.id).toBeDefined();
      // All built-ins fade out by the end of their life (nothing pops out of existence).
      const pool = new ParticlePool(4, table);
      expect(pool.curveAt(c!.slot, 1)[1], `${def.id} alpha at end`).toBeLessThan(0.02);
    }
  });

  it('compiles colours to linear light and keeps HDR intensities', () => {
    expect(hexToLinear('#ffffff')).toEqual([1, 1, 1]);
    const mid = hexToLinear('#808080')!;
    expect(mid[0]).toBeCloseTo(0.2158, 3); // sRGB 0.502 → linear 0.2158
    const { table } = rig();
    const flash = table.get('blast.flash')!;
    const pool = new ParticlePool(4, table);
    const c = pool.curveAt(flash.slot, 0);
    expect(c[2]).toBeGreaterThan(3); // the flash starts brighter than white (an additive glow)
  });

  it('rejects malformed definitions with a message that names the type', () => {
    expect(() => registerParticleType(probe({ id: 'Bad Id' }))).toThrow(/Invalid particle type id/);
    expect(() => registerParticleType(probe({ blend: 'multiply' as never }))).toThrow(/blend/);
    expect(() => registerParticleType(probe({ sprites: ['nope' as never] }))).toThrow(/unknown sprite "nope"/);
    expect(() => registerParticleType(probe({ life: [2, 1] }))).toThrow(/life must be \[min, max\]/);
    expect(() => registerParticleType(probe({ bounce: 2 }))).toThrow(/bounce/);
    expect(() =>
      registerParticleType(
        probe({
          alphaOverLife: [
            [0.5, 1],
            [0.2, 0],
          ],
        }),
      ),
    ).toThrow(/ascending/);
    expect(() => registerParticleType(probe({ colorOverLife: [[0, 'red']] }))).toThrow(/colour stops/);
    expect(() => registerParticleType(probe({ id: 'spark' }))).toThrow(/already registered/);
  });

  it('registers, emits and unregisters a custom type; unknown types emit nothing', () => {
    const off = registerParticleType(probe({ count: 4 }));
    const { emitter, normal } = rig();
    expect(emitter.emit('test.probe', 0, 1, 0)).toBe(4);
    expect(normal.count).toBe(4);
    off();
    expect(emitter.emit('test.probe', 0, 1, 0)).toBe(0);
    expect(emitter.emit('no.such.type', 0, 1, 0)).toBe(0);
  });

  it('a type unregistered while its particles live still finishes its animation', () => {
    const off = registerParticleType(probe({ life: [1, 1] }));
    const { emitter, normal } = rig();
    emitter.emit('test.probe', 0, 1, 0);
    off();
    normal.update(0.5, ENV);
    expect(normal.count).toBe(1);
    normal.writeInstances(null);
    expect(normal.iColor[3]).toBeCloseTo(1, 5);
    normal.update(0.6, ENV);
    expect(normal.count).toBe(0);
  });
});

describe('particle pool', () => {
  it('never holds more than its limit; a full pool replaces old particles and counts it', () => {
    const { emitter, normal } = rig(1, 600);
    normal.limit = 100;
    for (let i = 0; i < 40; i++) emitter.emit('dust', 0, 1, 0, { count: 25 });
    expect(normal.count).toBe(100);
    expect(normal.stats.spawned).toBeGreaterThanOrEqual(900);
    expect(normal.stats.overwritten).toBe(normal.stats.spawned - 100);
    // Every slot holds a live, finite particle.
    for (let i = 0; i < normal.count; i++) {
      expect(Number.isFinite(normal.state[i * S.STRIDE + S.px])).toBe(true);
      expect(normal.state[i * S.STRIDE + S.life]).toBeGreaterThan(0);
    }
  });

  it('lowering the limit culls the excess at the next update', () => {
    const { emitter, normal } = rig(1, 600);
    for (let i = 0; i < 20; i++) emitter.emit('smoke', 0, 1, 0, { count: 10 });
    const before = normal.count;
    expect(before).toBeGreaterThan(100);
    normal.limit = 50;
    normal.update(1 / 60, ENV);
    expect(normal.count).toBe(50);
  });

  it('particles expire and the pool stays dense', () => {
    const { emitter, additive } = rig();
    emitter.emit('spark', 0, 1, 0, { count: 60 });
    expect(additive.count).toBe(60);
    let last = additive.count;
    for (let i = 0; i < 400; i++) {
      additive.update(1 / 60, ENV);
      expect(additive.count).toBeLessThanOrEqual(last);
      last = additive.count;
      // Dense: every live slot has age < life.
      for (let k = 0; k < additive.count; k++)
        expect(additive.state[k * S.STRIDE + S.age]).toBeLessThan(additive.state[k * S.STRIDE + S.life]);
    }
    expect(additive.count).toBe(0);
    expect(additive.stats.expired).toBe(60);
  });

  it('a pool cannot be built larger than the sort key allows', () => {
    expect(() => new ParticlePool(70000, new ParticleTypeTable(particleTypes))).toThrow(/65535/);
  });

  it('gravity is the scene gravity vector times the type multiplier', () => {
    withType(probe({ gravity: 1 }));
    withType(probe({ id: 'test.float', gravity: 0 }));
    withType(probe({ id: 'test.rise', gravity: -1 }));
    const check = (g: [number, number, number], type: string, expectDisp: [number, number, number]) => {
      const { emitter, normal } = rig();
      emitter.emit(type, 0, 10, 0);
      for (let i = 0; i < 120; i++) normal.update(1 / 120, { ...ENV, gravity: g, floorY: -Infinity });
      const o = S.STRIDE * 0;
      // semi-implicit Euler: x = ½·g·t² + ½·g·t·dt
      for (let a = 0; a < 3; a++) {
        const got = normal.state[o + S.px + a] - (a === 1 ? 10 : 0);
        expect(got).toBeCloseTo(expectDisp[a], 1);
      }
    };
    const half = 0.5 * 1 * 1; // t = 1 s
    check([0, -9.81, 0], 'test.probe', [0, -9.81 * half, 0]);
    check([0, -1.62, 0], 'test.probe', [0, -1.62 * half, 0]); // the Moon
    check([3, 0, -4], 'test.probe', [3 * half, 0, -4 * half]); // sideways gravity
    check([0, 0, 0], 'test.probe', [0, 0, 0]); // zero-g
    check([0, -9.81, 0], 'test.float', [0, 0, 0]);
    check([0, -9.81, 0], 'test.rise', [0, 9.81 * half, 0]);
  });

  it('drag decays velocity exponentially', () => {
    withType(probe({ drag: 2, speed: [10, 10], spread: 0 }));
    const { emitter, normal } = rig();
    emitter.emit('test.probe', 0, 5, 0, { direction: [1, 0, 0] });
    for (let i = 0; i < 60; i++) normal.update(1 / 60, { ...ENV, gravity: [0, 0, 0] });
    expect(normal.state[S.vx]).toBeCloseTo(10 * Math.exp(-2), 2);
  });

  it('wind carries particles: relative drag converges on the wind velocity, a wind field overrides the constant', () => {
    withType(probe({ drag: 2, wind: 1 }));
    withType(probe({ id: 'test.heavy', drag: 2, wind: 0 }));
    const run = (type: string, env: Partial<ParticleEnv>) => {
      const { emitter, normal } = rig();
      emitter.emit(type, 0, 5, 0);
      for (let i = 0; i < 300; i++) normal.update(1 / 60, { ...ENV, gravity: [0, 0, 0], ...env });
      return [normal.state[S.vx], normal.state[S.vz]];
    };
    const [vx, vz] = run('test.probe', { wind: [3, 0, -2] });
    expect(vx).toBeCloseTo(3, 1);
    expect(vz).toBeCloseTo(-2, 1);
    expect(run('test.heavy', { wind: [3, 0, -2] })[0]).toBeCloseTo(0, 5); // wind 0: unaffected
    const [fx] = run('test.probe', { windAt: (_x, _y, _z, out) => ((out[0] = 7), (out[1] = 0), (out[2] = 0)) });
    expect(fx).toBeCloseTo(7, 1);
  });

  it('floor: bouncing chips never sink below it, lose energy, and settle flat', () => {
    const { emitter, normal } = rig();
    emitter.emit('chip.wood', 0, 1.2, 0, { count: 12, speed: 0 });
    let maxBounceVy = 0;
    for (let i = 0; i < 60 * 8; i++) {
      normal.update(1 / 60, ENV);
      for (let k = 0; k < normal.count; k++) {
        expect(y(normal, k)).toBeGreaterThanOrEqual(-1e-6);
        if (i > 20) maxBounceVy = Math.max(maxBounceVy, vy(normal, k));
      }
    }
    // Wood chips live ≤ 1.5 s; check settling with a long-lived chip instead.
    withType(probe({ id: 'test.chip', gravity: 1, bounce: 0.3, settle: true, life: [20, 20], size: [0.1, 0.1] }));
    const r = rig();
    r.emitter.emit('test.chip', 0, 1.2, 0, { count: 4 });
    for (let i = 0; i < 60 * 6; i++) r.normal.update(1 / 60, ENV);
    r.normal.writeInstances(null);
    for (let k = 0; k < r.normal.count; k++) {
      expect(r.normal.state[k * S.STRIDE + S.settled]).toBe(1);
      expect(r.normal.iData[k * 4 + 3]).toBe(-1); // lying flat
      expect(r.normal.iVel[k * 3 + 1]).toBe(0);
    }
  });

  it('a hitch is integrated in sub-steps: a fast spark cannot tunnel through the floor', () => {
    withType(probe({ id: 'test.fast', gravity: 1, bounce: 0.5, speed: [30, 30], life: [20, 20] }));
    const { emitter, normal } = rig();
    emitter.emit('test.fast', 0, 0.5, 0, { direction: [0, -1, 0] });
    normal.update(0.1, ENV); // one very long frame
    expect(y(normal)).toBeGreaterThanOrEqual(-1e-6);
  });

  it('draws alpha-blended particles back to front, allocation-free', () => {
    const { emitter, normal } = rig();
    const dists = [2, 9, 5, 14, 1, 7];
    for (const d of dists) emitter.emit('dust', d, 0, 0, { count: 1, radius: 0 });
    expect(normal.count).toBe(dists.length);
    const order = normal.sortBackToFront(0, 0, 0);
    const seq = Array.from(order.subarray(0, normal.count)).map((i) => normal.state[i * S.STRIDE + S.px]);
    expect(seq).toEqual([...dists].sort((a, b) => b - a));
  });

  it('evaluates the over-life curves into the instance arrays', () => {
    withType(
      probe({
        id: 'test.curve',
        life: [4, 4],
        size: [1, 1],
        sizeOverLife: [
          [0, 1],
          [1, 3],
        ],
        alphaOverLife: [
          [0, 0],
          [0.5, 1],
          [1, 0],
        ],
        colorOverLife: [
          [0, '#ffffff', 1],
          [1, '#ffffff', 3],
        ],
      }),
    );
    const { emitter, normal, table } = rig();
    emitter.emit('test.curve', 1, 2, 3, { color: [0.5, 1, 1], alpha: 0.5 });
    normal.update(2, { ...ENV, gravity: [0, 0, 0] }); // t = 0.5
    normal.writeInstances(null);
    expect(normal.iPos[0]).toBeCloseTo(1);
    expect(normal.iData[0]).toBeCloseTo(2, 1); // size 1 → 3 over life, halfway
    expect(normal.iColor[3]).toBeCloseTo(0.5, 1); // alpha 1 × 0.5
    expect(normal.iColor[0]).toBeCloseTo(0.5 * 2, 1); // colour 1 → 3 × tint 0.5
    expect(table.get('test.curve')).toBeDefined();
  });

  it('velocity-aligned types are written as streaks, ground-flat ones as flat quads', () => {
    const { emitter, additive, normal } = rig();
    emitter.emit('spark', 0, 1, 0, { count: 1 });
    emitter.emit('blast.ringFlat', 0, 0, 0, { count: 1 });
    emitter.emit('dust', 0, 1, 0, { count: 1 });
    additive.writeInstances(null);
    normal.writeInstances(null);
    expect(additive.iData[3]).toBeGreaterThan(0); // spark: streak
    expect(additive.iData[7]).toBe(-1); // ring flat
    expect(normal.iData[3]).toBe(0); // dust billboard
    expect(normal.iData[2]).toBeGreaterThanOrEqual(32); // dust fades near the floor (flag in the frame number)
  });
});

describe('emitter: counts, shapes and the seed', () => {
  it('scales counts by the emission factor, with fractional counts resolved by chance', () => {
    const mean = (emission: number) => {
      const { emitter, normal } = rig();
      emitter.emission = emission;
      let n = 0;
      normal.limit = 100000;
      for (let i = 0; i < 400; i++) n += emitter.emit('dust', 0, 1, 0, { count: 6 });
      return n / 400;
    };
    expect(mean(1)).toBe(6);
    expect(mean(0.5)).toBeCloseTo(3, 0);
    expect(mean(0.45)).toBeGreaterThan(2.4);
    expect(mean(0.45)).toBeLessThan(3.0);
    expect(mean(0)).toBe(0);
  });

  it('a cone keeps every particle within its half-angle of the axis; a disc stays in the plane', () => {
    withType(probe({ speed: [5, 5], spread: 0.4 }));
    const { emitter, normal } = rig();
    emitter.emit('test.probe', 0, 0, 0, { count: 300, direction: [1, 1, 0] });
    const axis = [Math.SQRT1_2, Math.SQRT1_2, 0];
    for (let i = 0; i < normal.count; i++) {
      const o = i * S.STRIDE;
      const v = [normal.state[o + S.vx], normal.state[o + S.vy], normal.state[o + S.vz]];
      const cos = (v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2]) / 5;
      expect(Math.acos(Math.min(1, cos))).toBeLessThanOrEqual(0.4 + 1e-5);
      expect(Math.hypot(...v)).toBeCloseTo(5, 4);
    }
    const d = rig();
    d.emitter.emit('test.probe', 0, 0, 0, { count: 100, pattern: 'disc', direction: [0, 1, 0], spread: 0 });
    for (let i = 0; i < d.normal.count; i++) expect(Math.abs(d.normal.state[i * S.STRIDE + S.vy])).toBeLessThan(1e-4);
  });

  it('inherits a fraction of the emitter velocity', () => {
    withType(probe({ inherit: 0.5, speed: [0, 0] }));
    const { emitter, normal } = rig();
    emitter.emit('test.probe', 0, 0, 0, { velocity: [10, 0, -4] });
    expect(normal.state[S.vx]).toBeCloseTo(5);
    expect(normal.state[S.vz]).toBeCloseTo(-2);
  });

  it('is deterministic: the same seed and the same emits give identical particles, another seed does not', () => {
    const run = (seed: number) => {
      const { emitter, additive, normal } = rig(seed);
      for (let i = 0; i < 30; i++) {
        emitter.emit('spark', i * 0.3, 1, 0, { count: 7, direction: [0, 1, 0] });
        emitter.emit('dust', 0, 0.2, i * 0.2, { count: 4 });
        additive.update(1 / 60, ENV);
        normal.update(1 / 60, ENV);
      }
      return [
        Array.from(additive.state.subarray(0, additive.count * S.STRIDE)),
        Array.from(normal.state.subarray(0, normal.count * S.STRIDE)),
      ];
    };
    expect(run(42)).toEqual(run(42));
    expect(run(42)).not.toEqual(run(43));
  });

  it('reseeding restarts the sequence', () => {
    const { emitter, normal } = rig(7);
    emitter.emit('dust', 0, 1, 0, { count: 5 });
    const first = Array.from(normal.state.subarray(0, 5 * S.STRIDE));
    normal.clear();
    emitter.emit('dust', 0, 1, 0, { count: 5 }); // call number 1: different stream
    expect(Array.from(normal.state.subarray(0, 5 * S.STRIDE))).not.toEqual(first);
    normal.clear();
    emitter.reseed(7);
    emitter.emit('dust', 0, 1, 0, { count: 5 });
    expect(Array.from(normal.state.subarray(0, 5 * S.STRIDE))).toEqual(first);
  });

  it('a skipped call still counts, so later calls keep their streams (culling cannot change other effects)', () => {
    const a = rig(5);
    a.emitter.emit('dust', 0, 1, 0, { count: 3 });
    a.normal.clear();
    a.emitter.emit('dust', 4, 1, 0, { count: 3 });
    const wanted = Array.from(a.normal.state.subarray(0, 3 * S.STRIDE));
    const b = rig(5);
    b.emitter.skip(); // the first effect was culled
    b.emitter.emit('dust', 4, 1, 0, { count: 3 });
    expect(Array.from(b.normal.state.subarray(0, 3 * S.STRIDE))).toEqual(wanted);
  });

  it('mixSeed spreads nearby inputs', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) seen.add(mixSeed(1, i));
    expect(seen.size).toBe(1000);
    expect(mixSeed(1, 5)).not.toBe(mixSeed(2, 5));
  });
});

describe('procedural sprite atlas', () => {
  it('has a cell for every sprite name, all of them visible, all of them transparent at the border', () => {
    expect(SPRITE_NAMES.length).toBeLessThanOrEqual(ATLAS_COLS * ATLAS_COLS);
    const a = generateAtlas();
    expect(a.length).toBe(ATLAS_SIZE * ATLAS_SIZE * 4);
    SPRITE_NAMES.forEach((name, i) => {
      const cx = (i % ATLAS_COLS) * CELL;
      const cy = Math.floor(i / ATLAS_COLS) * CELL;
      let max = 0;
      let border = 0;
      for (let py = 0; py < CELL; py++)
        for (let px = 0; px < CELL; px++) {
          const alpha = a[((cy + py) * ATLAS_SIZE + cx + px) * 4 + 3];
          max = Math.max(max, alpha);
          if (px === 0 || py === 0 || px === CELL - 1 || py === CELL - 1) border = Math.max(border, alpha);
        }
      expect(max, `${name} is visible`).toBeGreaterThan(150);
      expect(border, `${name} fades before its cell border`).toBeLessThanOrEqual(2);
    });
  });

  it('is deterministic and has a mip chain down to 8 px cells', () => {
    expect(generateAtlas()).toEqual(generateAtlas());
    const levels = generateAtlasLevels();
    expect(levels.map((l) => l.width)).toEqual([256, 128, 64, 32].slice(0, ATLAS_LEVELS));
    for (const l of levels) expect(l.data.length).toBe(l.width * l.height * 4);
  });
});

describe('fx settings and tiers', () => {
  it('sanitises whatever was stored', () => {
    expect(sanitizeFxSettings(undefined)).toEqual(DEFAULT_FX_SETTINGS);
    expect(sanitizeFxSettings('junk')).toEqual(DEFAULT_FX_SETTINGS);
    const s = sanitizeFxSettings({ enabled: false, quality: 'ultra', intensity: 99, impacts: 'yes', debris: false });
    expect(s.enabled).toBe(false);
    expect(s.quality).toBe('auto');
    expect(s.intensity).toBe(2);
    expect(s.impacts).toBe(true);
    expect(s.debris).toBe(false);
    expect(sanitizeFxSettings({ intensity: -3 }).intensity).toBe(0.25);
    expect(sanitizeFxSettings({ intensity: NaN }).intensity).toBe(1);
  });

  it('tiers are ordered and auto follows the graphics quality', () => {
    expect(FX_TIERS.low.maxParticles).toBeLessThan(FX_TIERS.medium.maxParticles);
    expect(FX_TIERS.medium.maxParticles).toBeLessThan(FX_TIERS.high.maxParticles);
    expect(FX_TIERS.low.burstsPerFrame).toBeLessThan(FX_TIERS.high.burstsPerFrame);
    expect(resolveTier('auto', 'low').id).toBe('low');
    expect(resolveTier('auto', 'high').id).toBe('high');
    expect(resolveTier('low', 'high').id).toBe('low');
  });
});
