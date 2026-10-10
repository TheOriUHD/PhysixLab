import { describe, expect, it } from 'vitest';
import { Governor, LADDER, startLevel } from '../src/render/governor';
import {
  DEFAULT_GRAPHICS,
  EFFECT_IDS,
  cloneGraphics,
  legacyTier,
  passSignature,
  probeTier,
  resolveGraphics,
  sanitizeGraphics,
} from '../src/render/graphics';

describe('quality tiers (VZ-22)', () => {
  it("each tier turns on a superset of the cheaper tier's default effects", () => {
    const on = (t: 'low' | 'medium' | 'high' | 'ultra') =>
      new Set(EFFECT_IDS.filter((id) => resolveGraphics(DEFAULT_GRAPHICS, t)[id]));
    const [low, med, high, ultra] = [on('low'), on('medium'), on('high'), on('ultra')];
    for (const [a, b] of [
      [low, med],
      [med, high],
      [high, ultra],
    ] as const)
      for (const id of a) expect(b.has(id)).toBe(true);
    expect(low.size).toBe(0);
    expect(ultra.has('ssr') && ultra.has('motionBlur') && ultra.has('godRays') && ultra.has('bloom')).toBe(true);
    expect(high.has('ssr')).toBe(false);
  });

  it('a user override wins over the tier in both directions', () => {
    const g = cloneGraphics(DEFAULT_GRAPHICS);
    g.bloom.on = false;
    g.dof.on = true;
    expect(resolveGraphics(g, 'ultra').bloom).toBeNull();
    expect(resolveGraphics(g, 'low').dof).not.toBeNull();
  });

  it('shadows, AA and pixel ratio follow the tier; explicit AA and shadow options win', () => {
    expect(resolveGraphics(DEFAULT_GRAPHICS, 'low').shadows.enabled).toBe(false);
    expect(resolveGraphics(DEFAULT_GRAPHICS, 'low').pixelRatioCap).toBe(1);
    expect(resolveGraphics(DEFAULT_GRAPHICS, 'medium').aa).toBe('fxaa');
    expect(resolveGraphics(DEFAULT_GRAPHICS, 'high', 8).msaaSamples).toBe(4);
    expect(resolveGraphics(DEFAULT_GRAPHICS, 'ultra', 8).msaaSamples).toBe(8);
    expect(resolveGraphics(DEFAULT_GRAPHICS, 'ultra', 2).msaaSamples).toBe(2);
    const g = cloneGraphics(DEFAULT_GRAPHICS);
    g.aa = 'smaa';
    g.shadows = { enabled: true, resolution: 8192, softness: 1 };
    const r = resolveGraphics(g, 'low');
    expect(r.aa).toBe('smaa');
    expect(r.shadows.enabled && r.shadows.resolution === 8192).toBe(true);
    expect(resolveGraphics(DEFAULT_GRAPHICS, 'high').shadows.contactHardening).toBe(true);
    expect(resolveGraphics(DEFAULT_GRAPHICS, 'medium').shadows.contactHardening).toBe(false);
  });

  it('the pass signature changes only when the pass list changes, not when a slider moves', () => {
    const a = cloneGraphics(DEFAULT_GRAPHICS);
    const b = cloneGraphics(DEFAULT_GRAPHICS);
    b.bloom.strength = 2;
    expect(passSignature(resolveGraphics(a, 'high'))).toBe(passSignature(resolveGraphics(b, 'high')));
    b.dof.on = true;
    expect(passSignature(resolveGraphics(a, 'high'))).not.toBe(passSignature(resolveGraphics(b, 'high')));
  });

  it('sanitising repairs whatever a stored file carries', () => {
    const g = sanitizeGraphics({
      aa: 'ultra-sharp',
      resolutionScale: 9,
      bloom: { on: 'yes', strength: -4, threshold: 'x' },
      shadows: { resolution: 123, enabled: true },
      grading: { exposure: 100, saturation: NaN },
      evil: { __proto__: 1 },
    });
    expect(g.aa).toBe('auto');
    expect(g.resolutionScale).toBe(1);
    expect(g.bloom.on).toBeNull();
    expect(g.bloom.strength).toBe(0);
    expect(g.bloom.threshold).toBe(DEFAULT_GRAPHICS.bloom.threshold);
    expect(g.shadows.resolution).toBe('auto');
    expect(g.shadows.enabled).toBe(true);
    expect(g.grading.exposure).toBe(3);
    expect(g.grading.saturation).toBe(1);
    expect(sanitizeGraphics(null)).toEqual(DEFAULT_GRAPHICS);
    expect(sanitizeGraphics(JSON.parse(JSON.stringify(g)))).toEqual(g);
  });

  it('the legacy three-step tier collapses ultra to high and auto to the active tier', () => {
    expect(legacyTier('ultra', 'low')).toBe('high');
    expect(legacyTier('auto', 'ultra')).toBe('high');
    expect(legacyTier('auto', 'low')).toBe('low');
    expect(legacyTier('medium', 'ultra')).toBe('medium');
  });

  it('the GPU probe puts software renderers on low and discrete GPUs high', () => {
    expect(probeTier('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))')).toBe('low');
    expect(probeTier('llvmpipe (LLVM 15.0.7, 256 bits)')).toBe('low');
    expect(probeTier('ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11)')).toBe('ultra');
    expect(probeTier('ANGLE (Intel, Intel(R) UHD Graphics 620)')).toBe('medium');
    expect(probeTier('Adreno (TM) 650')).toBe('medium');
    expect(probeTier('unknown gpu', true)).toBe('medium');
  });
});

describe('Auto governor (VZ-22)', () => {
  const run = (g: Governor, seconds: number, ms: number): number => {
    let changes = 0;
    for (let t = 0; t < seconds; t += ms / 1000) if (g.update(ms / 1000)) changes++;
    return changes;
  };

  it('steps down when frames are slow and keeps going until the ladder ends', () => {
    const g = new Governor('ultra');
    expect(g.level).toBe(0);
    run(g, 60, 50); // 20 fps
    expect(g.level).toBe(LADDER.length - 1);
    expect(g.step.tier).toBe('low');
    expect(g.step.scale).toBeLessThan(1);
  });

  it('holds still at a steady good frame rate and never exceeds the probe ceiling', () => {
    const g = new Governor('high');
    const start = g.level;
    expect(run(g, 60, 16)).toBe(0); // 62 fps: inside the dead band
    expect(g.level).toBe(start);
    run(g, 60, 5); // 200 fps: lots of headroom, but high is the probe's ceiling
    expect(g.level).toBe(start);
  });

  it('climbs back up only after sustained headroom, one step at a time, and not through the cool-down', () => {
    const g = new Governor('ultra');
    run(g, 5, 50); // down one or two steps
    const low = g.level;
    expect(low).toBeGreaterThan(0);
    const changes = run(g, 4, 5); // 4 s fast: below the 6 s up-delay
    expect(changes).toBe(0);
    run(g, 8, 5);
    expect(g.level).toBe(low - 1);
  });

  it('doubles the wait after an upgrade that did not hold (hysteresis)', () => {
    const g = new Governor('ultra');
    run(g, 5, 50);
    run(g, 12, 5); // climb once
    const up = g.level;
    run(g, 6, 50); // …and it was too much
    expect(g.level).toBeGreaterThan(up);
    const before = g.level;
    run(g, 9, 5); // 9 s of headroom is no longer enough (wait is now 12 s)
    expect(g.level).toBe(before);
  });

  it('ignores stalls (hidden tab) and non-positive frame times', () => {
    const g = new Governor('ultra');
    for (let i = 0; i < 100; i++) g.update(2);
    g.update(0);
    g.update(-1);
    g.update(NaN);
    expect(g.level).toBe(0);
  });

  it('reset jumps to a tier and clears the history', () => {
    const g = new Governor('ultra');
    run(g, 30, 50);
    g.reset('medium');
    expect(g.level).toBe(startLevel('medium'));
    expect(g.ceiling).toBe(g.level);
    expect(g.averageMs).toBe(0);
  });
});

import { linkedBodyIds, sanitizeHighlight, DEFAULT_HIGHLIGHT, PALETTES } from '../src/render/highlight';

describe('highlight (VZ-40)', () => {
  it('finds the bodies a selected joint connects, skipping the selected and the world end', () => {
    const ends: Record<string, (string | null)[]> = { j1: ['a', 'b'], j2: [null, 'c'] };
    expect(linkedBodyIds(['j1'], (id) => ends[id]).sort()).toEqual(['a', 'b']);
    expect(linkedBodyIds(['j1', 'a'], (id) => ends[id])).toEqual(['b']);
    expect(linkedBodyIds(['j2'], (id) => ends[id])).toEqual(['c']);
    expect(linkedBodyIds(['a'], (id) => ends[id])).toEqual([]);
  });
  it('sanitises options and keeps the four colours of each palette distinct', () => {
    expect(sanitizeHighlight({ palette: 'x', pulse: 1, bbox: true })).toEqual({ ...DEFAULT_HIGHLIGHT, bbox: true });
    for (const p of Object.values(PALETTES)) expect(new Set([p.selected, p.multi, p.hover, p.linked]).size).toBe(4);
  });
});

import { DamageModel, damageKindOf, impactDamage, sanitizeDamage } from '../src/render/damage';

describe('damage model (VZ-41)', () => {
  it('ignores soft touches and grows with speed, glass first and metal last', () => {
    for (const k of ['glass', 'wood', 'generic', 'metal'] as const) {
      expect(impactDamage(k, 0.5)).toBe(0);
      expect(impactDamage(k, 8)).toBeGreaterThanOrEqual(impactDamage(k, 4));
    }
    expect(impactDamage('glass', 5)).toBeGreaterThan(impactDamage('wood', 5));
    expect(impactDamage('wood', 5)).toBeGreaterThan(impactDamage('generic', 5));
    expect(impactDamage('generic', 5)).toBeGreaterThan(impactDamage('metal', 5));
    expect(impactDamage('metal', 100)).toBeCloseTo(0.6, 9);
  });
  it('accumulates up to 1, honours sensitivity / enabled, and resets', () => {
    const m = new DamageModel();
    m.hit('a', 'generic', 12);
    expect(m.get('a')).toBeCloseTo(0.6, 9);
    m.hit('a', 'generic', 12);
    expect(m.get('a')).toBe(1);
    m.settings = { enabled: true, sensitivity: 0.5 };
    m.hit('b', 'generic', 12);
    expect(m.get('b')).toBeCloseTo(0.3, 9);
    m.settings = { enabled: false, sensitivity: 1 };
    m.hit('c', 'generic', 12);
    expect(m.get('c')).toBe(0);
    m.reset();
    expect(m.size).toBe(0);
  });
  it('picks the look from the material and repairs stored settings', () => {
    expect(damageKindOf({ preset: 'glass', metalness: 0, opacity: 0.5 })).toBe('glass');
    expect(damageKindOf({ preset: 'oak', metalness: 0, opacity: 1 })).toBe('wood');
    expect(damageKindOf({ preset: 'steel', metalness: 0.9, opacity: 1 })).toBe('metal');
    expect(damageKindOf({ preset: 'rubber', metalness: 0, opacity: 1 })).toBe('generic');
    expect(sanitizeDamage({ enabled: 'x', sensitivity: 99 })).toEqual({ enabled: true, sensitivity: 4 });
  });
});

import { MeshStandardMaterial, BufferGeometry } from 'three';
import { patchDamage } from '../src/render/damageShader';
import { applyShapeSurface } from '../src/render/shapeSurface';
import { lodForScreenRadius } from '../src/render/lod';
import { InstancePool } from '../src/render/instancing';
import { Group, Object3D, Vector3 } from 'three';

describe('review regressions', () => {
  it('the damage shader patch survives the shape-surface setup of the same material', () => {
    const m = new MeshStandardMaterial();
    patchDamage(m, 'metal', false);
    applyShapeSurface(m, new BufferGeometry(), { type: 'box', size: [1, 1, 1] });
    expect(m.customProgramCacheKey()).toBe('dmg');
    const shader = {
      vertexShader: '#include <common>\n#include <begin_vertex>',
      fragmentShader: '#include <common>\n#include <color_fragment>\n#include <roughnessmap_fragment>',
      uniforms: {},
    };
    m.onBeforeCompile(shader as never, undefined as never);
    expect(shader.fragmentShader).toContain('dmgCrack');
  });

  it('a 60 Hz display does not stop the governor from climbing back after a stall', () => {
    const g = new Governor('ultra');
    for (let t = 0; t < 4; t += 0.05) g.update(0.05); // slow: steps down
    const low = g.level;
    expect(low).toBeGreaterThan(0);
    for (let t = 0; t < 60; t += 1 / 60) g.update(1 / 60); // vsync-capped 16.7 ms frames
    expect(g.level).toBeLessThan(low);
  });

  it('GTX 10xx low-end cards are not probed as ultra, 1060 and up are', () => {
    expect(probeTier('NVIDIA GeForce GTX 1050')).toBe('high');
    expect(probeTier('NVIDIA GeForce GTX 1060')).toBe('ultra');
    expect(probeTier('NVIDIA GeForce GTX 1080 Ti')).toBe('ultra');
  });

  it('LOD levels switch with hysteresis and never flicker around a threshold', () => {
    expect(lodForScreenRadius(100, 2)).toBe(0);
    expect(lodForScreenRadius(40, 1)).toBe(1); // just over 36 px but inside the band: stay
    expect(lodForScreenRadius(50, 1)).toBe(0);
    expect(lodForScreenRadius(11, 1)).toBe(1);
    expect(lodForScreenRadius(5, 1)).toBe(2);
  });

  it('instance pools keep slots consistent through add, remove and growth', () => {
    const parent = new Group();
    const mk = (id: string) => ({
      id,
      mesh: new Object3D(),
      scale: [1, 1, 1] as const,
      poolVisible: true,
      vel: new Vector3(),
      damage: 0,
      slot: -1,
    });
    const pool = new InstancePool('k', new BufferGeometry(), new MeshStandardMaterial(), parent, 4);
    const members = Array.from({ length: 40 }, (_, i) => mk(`b${i}`));
    for (const m of members) pool.add(m);
    expect(pool.size).toBe(40);
    for (const m of members.slice(0, 40)) expect(pool.mesh.userData.instanceIds[m.slot]).toBe(m.id);
    for (const i of [0, 7, 39, 20]) pool.remove(members[i]);
    expect(pool.size).toBe(36);
    for (const m of members.filter((_, i) => ![0, 7, 39, 20].includes(i)))
      expect(pool.mesh.userData.instanceIds[m.slot]).toBe(m.id);
    expect(members[7].slot).toBe(-1);
    pool.flush();
    expect(parent.children.length).toBe(1);
    pool.dispose();
    expect(parent.children.length).toBe(0);
  });
});
