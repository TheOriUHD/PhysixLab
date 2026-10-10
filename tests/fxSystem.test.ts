/**
 * The `Fx` object as a whole (FX-1, FX-5, FX-6 visuals): its public API driven without WebGL — emit, impact,
 * explosion, quality tiers and switches, camera culling, pause / clear, determinism of the whole state — plus the
 * draw-call setup the renderer builds (instance counts, blend modes, the pre-pass guard).
 */
import { describe, expect, it } from 'vitest';
import { AdditiveBlending, Group, NormalBlending, PointLight, type Mesh, type ShaderMaterial } from 'three';
import { Fx } from '../src/render/fx/fx';
import { explode } from '../src/render/fx/explosion';
import { ParticleEmitter } from '../src/render/fx/emitter';
import { registerBuiltinParticleTypes } from '../src/render/fx/builtinTypes';
import { ParticlePool } from '../src/render/fx/particlePool';
import { ParticleTypeTable, particleTypes } from '../src/render/fx/particleTypes';
import { DEFAULT_FX_SETTINGS, FX_TIERS, type FxSettings } from '../src/render/fx/settings';
import { surfaceFor } from '../src/render/fx/surfaces';

registerBuiltinParticleTypes();

const CAM = { position: { x: 0, y: 5, z: 12 } };
const make = (settings: Partial<FxSettings> = {}, graphics: 'low' | 'medium' | 'high' = 'medium') => {
  const parent = new Group();
  const fx = new Fx(parent, graphics);
  fx.configure({ ...DEFAULT_FX_SETTINGS, ...settings }, graphics);
  fx.reseed(1);
  return { fx, parent };
};
const flash = (parent: Group) => parent.children.find((c): c is PointLight => c instanceof PointLight)!;
const meshes = (parent: Group) => parent.children.filter((c): c is Mesh => (c as Mesh).isMesh);
const steelHit = {
  speed: 9,
  impulse: 3000,
  a: surfaceFor('steel'),
  b: surfaceFor('ground', '#2b3038'),
  bIsGround: true,
};

describe('Fx emit and update', () => {
  it('emits by type id, draws it in two instanced meshes with the right blend modes, and ages it out', () => {
    const { fx, parent } = make();
    fx.update(0, CAM);
    const [normal, additive] = meshes(parent).filter((m) => m.name.startsWith('fx-particles'));
    expect((normal.material as ShaderMaterial).blending).toBe(NormalBlending);
    expect((additive.material as ShaderMaterial).blending).toBe(AdditiveBlending);
    expect(normal.visible || additive.visible).toBe(false);

    expect(fx.emit('spark', [0, 1, 0], { count: 10 })).toBeGreaterThan(0);
    expect(fx.emit('dust', { x: 0, y: 0.1, z: 0 }, { count: 5 })).toBeGreaterThan(0);
    fx.update(1 / 60, CAM);
    expect(additive.visible).toBe(true);
    expect(normal.visible).toBe(true);
    expect((additive.geometry as unknown as { instanceCount: number }).instanceCount).toBe(fx.additive.count);
    expect((normal.geometry as unknown as { instanceCount: number }).instanceCount).toBe(fx.normal.count);
    expect(fx.stats.live).toBe(fx.additive.count + fx.normal.count);

    for (let i = 0; i < 400; i++) fx.update(1 / 60, CAM);
    expect(fx.stats.live).toBe(0);
    expect(additive.visible).toBe(false);
    expect(fx.time).toBeCloseTo(401 / 60, 6);
  });

  it('the instance buffers hold finite data for every live particle', () => {
    const { fx } = make();
    fx.explosion([0, 1, 0], { radius: 7 });
    fx.emit('chip.wood', [1, 0.5, 0], { count: 20 });
    for (let i = 0; i < 20; i++) fx.update(1 / 60, CAM);
    for (const pool of [fx.additive, fx.normal]) {
      for (const arr of [pool.iPos, pool.iVel, pool.iData, pool.iColor]) {
        const used = arr === pool.iPos || arr === pool.iVel ? pool.count * 3 : pool.count * 4;
        for (let i = 0; i < used; i++) expect(Number.isFinite(arr[i])).toBe(true);
      }
    }
  });

  it('does not advance while time stands still (paused simulation) but still re-sorts for a moved camera', () => {
    const { fx } = make();
    fx.emit('smoke', [0, 1, 0], { count: 20 });
    fx.update(1 / 60, CAM);
    const d = fx.digest();
    fx.update(0, CAM);
    fx.update(0, { position: { x: 4, y: 2, z: -3 } });
    expect(fx.digest()).toBe(d);
  });

  it('is deterministic for the scene seed: same seed, same calls, same state', () => {
    const run = (seed: number) => {
      const { fx } = make();
      fx.reseed(seed);
      for (let i = 0; i < 25; i++) {
        fx.impact({ ...steelHit, position: [i * 0.2, 0.02, 0], normal: [0, 1, 0] });
        if (i % 7 === 0) fx.explosion([i, 1, 0], { radius: 4 });
        fx.update(1 / 60, CAM);
      }
      return fx.digest();
    };
    expect(run(9)).toBe(run(9));
    expect(run(9)).not.toBe(run(10));
  });

  it('reseed() restarts the sequence of random streams', () => {
    const { fx } = make();
    fx.emit('dust', [0, 1, 0], { count: 4 });
    const d1 = fx.digest();
    fx.clear();
    fx.reseed(1);
    fx.emit('dust', [0, 1, 0], { count: 4 });
    expect(fx.digest()).toBe(d1);
  });
});

describe('sprite atlas', () => {
  it('is generated when the first particle needs it, and only once', () => {
    const { fx } = make();
    expect(fx.renderer.atlasIsReady).toBe(false);
    fx.update(0, CAM); // nothing to draw yet
    expect(fx.renderer.atlasIsReady).toBe(false);
    fx.emit('spark', [0, 1, 0], { count: 5 });
    fx.update(1 / 60, CAM);
    expect(fx.renderer.atlasIsReady).toBe(true);
    const tex = (fx.renderer.meshes[0].material as ShaderMaterial).uniforms.uMap.value as { image: { width: number } };
    expect(tex.image.width).toBe(256);
    fx.renderer.ensureAtlas();
    expect((fx.renderer.meshes[0].material as ShaderMaterial).uniforms.uMap.value).toBe(tex);
  });
});

describe('quality tiers, intensity and switches', () => {
  it('the live particle count never exceeds the tier budget, however much is thrown at it', () => {
    for (const graphics of ['low', 'medium', 'high'] as const) {
      const { fx } = make({}, graphics);
      for (let i = 0; i < 400; i++) {
        fx.emit('dust', [i % 10, 0.2, 0], { count: 30 });
        fx.emit('spark', [0, 1, i % 10], { count: 30 });
        if (i % 40 === 0) fx.update(1 / 120, CAM);
      }
      fx.update(1 / 120, CAM);
      expect(fx.stats.live, graphics).toBeLessThanOrEqual(FX_TIERS[graphics].maxParticles);
      expect(fx.stats.live, graphics).toBeGreaterThan(FX_TIERS[graphics].maxParticles * 0.9);
      expect(fx.stats.overwritten).toBeGreaterThan(0);
    }
  });

  it('quality "auto" follows the graphics setting; an explicit tier overrides it; intensity scales counts', () => {
    expect(make({ quality: 'auto' }, 'low').fx.tier.id).toBe('low');
    expect(make({ quality: 'high' }, 'low').fx.tier.id).toBe('high');
    const count = (intensity: number) => {
      const { fx } = make({ intensity, quality: 'high' });
      let n = 0;
      for (let i = 0; i < 100; i++) n += fx.emit('dust', [0, 1, 0], { count: 10 });
      return n;
    };
    expect(count(2)).toBeGreaterThan(count(1) * 1.7);
    expect(count(0.25)).toBeLessThan(count(1) * 0.35);
  });

  it('master switch off: nothing is emitted, and switching off clears what is alive', () => {
    const { fx } = make();
    fx.emit('spark', [0, 1, 0], { count: 20 });
    fx.explosion([0, 1, 0], { radius: 5 });
    fx.update(1 / 60, CAM);
    expect(fx.stats.live).toBeGreaterThan(0);
    fx.configure({ ...DEFAULT_FX_SETTINGS, enabled: false }, 'medium');
    expect(fx.stats.live).toBe(0);
    expect(fx.emit('spark', [0, 1, 0], { count: 20 })).toBe(0);
    expect(fx.explosion([0, 1, 0], { radius: 5 })).toBe(false);
    expect(fx.impact({ ...steelHit, position: [0, 0, 0], normal: [0, 1, 0] })).toEqual([]);
    fx.skid(1, 0, 0, 0.3, 1, 0);
    fx.skid(1, 1, 0, 0.3, 1, 0);
    expect(fx.stats.skidSegments).toBe(0);
  });

  it('each effect has its own switch: impacts, explosions, debris, skid marks', () => {
    const hit = {
      ...steelHit,
      a: surfaceFor('steel'),
      b: surfaceFor('glass'),
      bIsGround: false,
      speed: 14,
      impulse: 60000,
      position: [0, 1, 0] as [number, number, number],
      normal: [0, 1, 0] as [number, number, number],
    };
    const bursts = (s: Partial<FxSettings>) =>
      make(s)
        .fx.impact(hit)
        .map((b) => b.type);
    expect(bursts({})).toContain('spark');
    expect(bursts({})).toContain('debris');
    expect(bursts({ impacts: false })).toEqual(['debris']);
    expect(bursts({ debris: false })).not.toContain('debris');
    expect(bursts({ debris: false })).toContain('spark');
    expect(bursts({ impacts: false, debris: false })).toEqual([]);
    expect(make({ explosions: false }).fx.explosion([0, 1, 0], { radius: 5 })).toBe(false);
    const sk = make({ skidMarks: false }).fx;
    for (let i = 0; i < 20; i++) sk.skid(1, i * 0.2, 0, 0.3, 1, 0);
    expect(sk.stats.skidSegments).toBe(0);
    const sk2 = make({ skidMarks: true }).fx;
    for (let i = 0; i < 20; i++) sk2.skid(1, i * 0.2, 0, 0.3, 1, 0);
    expect(sk2.stats.skidSegments).toBeGreaterThan(5);
  });

  it('physical debris is independent of the visual chips: the burst is handed to the caller, no chunk particles are drawn', () => {
    const hit = {
      ...steelHit,
      a: surfaceFor('steel'),
      b: surfaceFor('glass'),
      bIsGround: false,
      speed: 14,
      impulse: 60000,
      position: [0, 1, 0] as [number, number, number],
      normal: [0, 1, 0] as [number, number, number],
    };
    const only = make({ debris: false, physicalDebris: true, impacts: false });
    const bursts = only.fx.impact(hit);
    expect(bursts.map((b) => b.type)).toEqual(['debris']);
    expect(bursts[0].physical).toBe(true);
    expect(only.fx.emittedByType()['debris']).toBeUndefined(); // no visual chunks
    const both = make({ physicalDebris: true });
    both.fx.impact(hit);
    expect(both.fx.emittedByType()['debris']).toBeGreaterThan(0);
    expect(make({ physicalDebris: false, debris: false, impacts: false }).fx.impact(hit)).toEqual([]);
  });

  it('previews ignore the per-effect switches (not the master switch): you can try an effect you have turned off', () => {
    const off = { impacts: false, explosions: false, debris: false, skidMarks: false };
    const hit = {
      ...steelHit,
      position: [0, 0.02, 0] as [number, number, number],
      normal: [0, 1, 0] as [number, number, number],
    };
    const { fx } = make(off);
    expect(fx.impact(hit)).toEqual([]);
    expect(fx.impact(hit, true).length).toBeGreaterThan(0);
    expect(fx.explosion([0, 1, 0], { radius: 4 })).toBe(false);
    expect(fx.explosion([0, 1, 0], { radius: 4 }, true)).toBe(true);
    const masterOff = make({ enabled: false }).fx;
    expect(masterOff.impact(hit, true)).toEqual([]);
    expect(masterOff.explosion([0, 1, 0], { radius: 4 }, true)).toBe(false);
  });

  it('effects farther from the camera than the tier allows are not spawned (and counted)', () => {
    const { fx } = make({}, 'low');
    fx.update(0, CAM);
    expect(fx.emit('spark', [0, 1, 0], { count: 10 })).toBeGreaterThan(0);
    expect(fx.emit('spark', [0, 1, FX_TIERS.low.maxDistance + 50], { count: 10 })).toBe(0);
    expect(fx.stats.culled).toBe(1);
    expect(fx.explosion([500, 1, 0], { radius: 5 })).toBe(false);
  });
});

describe('Fx impact', () => {
  it('emits the recipe: sparks and dust along the normal, with the burst list returned for physical debris', () => {
    const { fx } = make();
    const bursts = fx.impact({ ...steelHit, position: [1, 0.02, 2], normal: [0, 1, 0] });
    expect(bursts.map((b) => b.type)).toEqual(expect.arrayContaining(['spark', 'dust']));
    expect(fx.stats.bursts).toBe(1);
    fx.update(1 / 60, CAM);
    // sparks go up (the normal), not down
    let up = 0;
    for (let i = 0; i < fx.additive.count; i++) if (fx.additive.iVel[i * 3 + 1] > 0) up++;
    expect(up).toBe(fx.additive.count);
    // gentle contact: nothing
    expect(fx.impact({ ...steelHit, speed: 0.4, impulse: 1, position: [0, 0, 0], normal: [0, 1, 0] })).toEqual([]);
  });

  it('particles take the gravity of the scene: on the Moon a spark falls six times slower', () => {
    const fall = (g: number) => {
      const { fx } = make();
      fx.setEnvironment({ gravity: [0, -g, 0], floorY: -Infinity });
      fx.emit('spark', [0, 50, 0], { count: 1, speed: 0 });
      for (let i = 0; i < 20; i++) fx.update(1 / 60, CAM);
      return 50 - fx.additive.state[1];
    };
    expect(fall(9.81) / fall(1.62)).toBeGreaterThan(4.5);
    expect(fall(0)).toBeLessThan(0.1);
  });
});

describe('explosion (FX-5)', () => {
  it('has all five parts: fireball, shock ring, debris, smoke and a light flash, in proportion to the radius', () => {
    const { fx, parent } = make();
    const light = flash(parent);
    expect(light.intensity).toBe(0);
    expect(fx.explosion([0, 8, 0], { radius: 7 })).toBe(true);
    expect(fx.stats.explosions).toBe(1);
    expect(light.intensity).toBeGreaterThan(100); // a real, bright flash (candela)
    fx.update(1 / 60, CAM);
    const slots = new Set<string>();
    for (const pool of [fx.additive, fx.normal])
      for (let i = 0; i < pool.count; i++) slots.add(fx.types.slots[pool.state[i * 19 + 16]].def.id);
    for (const id of ['blast.flash', 'blast.fire', 'blast.ring', 'spark.hot', 'debris', 'smoke.dark'])
      expect(slots, id).toContain(id);
    expect(slots).not.toContain('blast.ringFlat'); // 8 m above the floor, radius 7: the shock never reaches the ground

    const small = make();
    small.fx.explosion([0, 8, 0], { radius: 2 });
    expect(flash(small.parent).intensity).toBeLessThan(light.intensity / 8); // ∝ radius²
    expect(small.fx.stats.spawned).toBeLessThan(fx.stats.spawned);
  });

  it('the light flash decays to nothing within about a second; a weaker flash does not cut off a stronger one', () => {
    const { fx, parent } = make();
    const light = flash(parent);
    fx.explosion([0, 3, 0], { radius: 7 });
    const peak = light.intensity;
    fx.update(0.1, CAM);
    expect(light.intensity).toBeLessThan(peak * 0.6);
    fx.explosion([2, 3, 0], { radius: 1 });
    expect(light.intensity).toBeLessThan(peak * 0.6); // not replaced by the weak one
    for (let i = 0; i < 60; i++) fx.update(1 / 60, CAM);
    expect(light.intensity).toBe(0);
  });

  it('near the floor it adds the ground ring and a ring of dust; the low tier has no light flash; reduced motion dims it', () => {
    const { fx } = make();
    fx.explosion([0, 0.5, 0], { radius: 7 });
    fx.update(1 / 60, CAM);
    const ids = new Set<string>();
    for (const pool of [fx.additive, fx.normal])
      for (let i = 0; i < pool.count; i++) ids.add(fx.types.slots[pool.state[i * 19 + 16]].def.id);
    expect(ids).toContain('blast.ringFlat');
    expect(ids).toContain('blast.dust');

    const low = make({}, 'low');
    low.fx.explosion([0, 1, 0], { radius: 7 });
    expect(flash(low.parent).intensity).toBe(0);

    const dim = make();
    dim.fx.setFlashScale(0.3);
    dim.fx.explosion([0, 1, 0], { radius: 7 });
    const normalFlash = make();
    normalFlash.fx.explosion([0, 1, 0], { radius: 7 });
    expect(flash(dim.parent).intensity).toBeCloseTo(flash(normalFlash.parent).intensity * 0.3, 3);
  });

  it('a projectile hit (kind: impact) is the small version', () => {
    const t = new ParticleTypeTable(particleTypes);
    const mk = () => {
      const a = new ParticlePool(2000, t);
      const n = new ParticlePool(2000, t);
      return { a, n, e: new ParticleEmitter(t, a, n) };
    };
    const big = mk();
    const small = mk();
    const lb = explode(big.e, 0, 2, 0, { radius: 3, kind: 'blast', floorY: 0 });
    const ls = explode(small.e, 0, 2, 0, { radius: 3, kind: 'impact', floorY: 0 });
    expect(small.a.count + small.n.count).toBeLessThan(big.a.count + big.n.count);
    expect(ls.intensity).toBeLessThan(lb.intensity);
  });
});

describe('draw-call guard and cleanup', () => {
  it('draws no instances while a normal / depth pre-pass overrides the materials', () => {
    const { fx, parent } = make();
    fx.emit('spark', [0, 1, 0], { count: 20 });
    fx.update(1 / 60, CAM);
    const additive = meshes(parent).find((m) => m.name === 'fx-particles-additive')!;
    const call = (override: object | null) =>
      additive.onBeforeRender(
        {} as never,
        { overrideMaterial: override } as never,
        {} as never,
        additive.geometry,
        additive.material as never,
        null as never,
      );
    call(null);
    expect((additive.geometry as unknown as { instanceCount: number }).instanceCount).toBe(fx.additive.count);
    call({});
    expect((additive.geometry as unknown as { instanceCount: number }).instanceCount).toBe(0);
  });

  it('clear() empties particles, skid marks and the flash; dispose() removes every object it added', () => {
    const { fx, parent } = make();
    fx.explosion([0, 1, 0], { radius: 6 });
    for (let i = 0; i < 30; i++) fx.skid(1, i * 0.2, 0, 0.3, 1, 0);
    expect(fx.stats.live).toBeGreaterThan(0);
    expect(fx.stats.skidSegments).toBeGreaterThan(0);
    fx.clear();
    expect(fx.stats.live).toBe(0);
    expect(fx.stats.skidSegments).toBe(0);
    expect(flash(parent).intensity).toBe(0);
    fx.dispose();
    expect(parent.children).toHaveLength(0);
  });
});
