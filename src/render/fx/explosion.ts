/**
 * Explosion recipes: the particles of a blast (the blast tool) and of a hard projectile hit.
 *
 * A blast is a fireball (additive flame puffs flying outward and rising), a billboard shock ring that expands to the
 * blast radius, embers and debris thrown out ballistically, dark smoke that billows and drifts, and — when the blast
 * is near the floor — a flat ground ring and a ring of dust racing outward. `explode` returns the parameters of the
 * light flash for the caller to drive (the light itself belongs to the scene, see `FlashLight` in `fx.ts`).
 *
 * Scale follows the radius: sizes ∝ radius, particle counts and speeds ∝ √radius, light ∝ radius². `kind: 'impact'`
 * is the small version used for a projectile hitting something at speed.
 */
import type { ParticleEmitter } from './emitter';

export interface ExplosionOptions {
  /** Blast radius, metres (the radius the physics pushes within). */
  radius: number;
  /** Strength relative to the default blast (1); 0.3 … 3. */
  energy?: number;
  kind?: 'blast' | 'impact';
  /** Height of the floor, or −Infinity when there is none. */
  floorY?: number;
}

export interface ExplosionLight {
  /** Peak intensity, candela (three.js physical units). */
  intensity: number;
  /** Time constant of the decay, seconds. */
  decay: number;
  /** Linear RGB. */
  color: [number, number, number];
  /** Range, metres (the light fades to nothing here). */
  range: number;
}

const DARK_EARTH: [number, number, number] = [0.18, 0.15, 0.12];

export function explode(e: ParticleEmitter, x: number, y: number, z: number, o: ExplosionOptions): ExplosionLight {
  const kind = o.kind ?? 'blast';
  const R = Math.max(0.2, o.radius);
  const en = Math.min(3, Math.max(0.3, o.energy ?? 1));
  const s = Math.min(2.5, Math.max(0.12, R / 7));
  const small = kind === 'impact';
  const floorY = o.floorY ?? -Infinity;
  const height = y - floorY;
  const nearFloor = height < R * 0.75;
  const k = Math.sqrt(s) * Math.sqrt(en);

  // Core flash and fireball.
  e.emit('blast.flash', x, y, z, { scale: R * (small ? 0.9 : 1.25), color: [1, 1, 1] });
  e.emit('blast.fire', x, y, z, {
    count: (small ? 5 : 15) * Math.pow(s, 0.6) * en,
    scale: R * 0.27,
    speed: 0.8 + 0.7 * k,
    pattern: 'sphere',
    radius: R * 0.1,
  });
  // Shock ring, billboarded (a sphere's silhouette from any angle).
  e.emit('blast.ring', x, y, z, { scale: R * 1.9 });

  // Embers: fast, ballistic, bouncing on the floor.
  e.emit('spark.hot', x, y, z, {
    count: (small ? 14 : 30) * Math.pow(s, 0.7) * en,
    speed: 0.7 + 0.45 * k,
    pattern: 'sphere',
    radius: R * 0.08,
  });
  // Debris chunks, dark earth and splinters.
  e.emit('debris', x, y, z, {
    count: (small ? 6 : 16) * Math.pow(s, 0.7) * en,
    speed: 1.1 + 0.5 * k,
    scale: 0.9 + 0.5 * s,
    color: DARK_EARTH,
    pattern: nearFloor ? 'cone' : 'sphere',
    direction: [0, 1, 0],
    spread: 1.35,
    radius: R * 0.08,
  });
  // Smoke.
  e.emit('smoke.dark', x, y, z, {
    count: (small ? 3 : 10) * Math.pow(s, 0.7) * en,
    scale: 0.55 + 0.7 * s,
    speed: 0.7 + 0.4 * k,
    pattern: 'sphere',
    radius: R * 0.14,
  });

  if (nearFloor && Number.isFinite(floorY)) {
    // A ground ring: the shock wave's footprint, radius reduced by the height of the blast above the floor.
    const footprint = Math.sqrt(Math.max(0.01, R * R - height * height));
    e.emit('blast.ringFlat', x, floorY + 0.03, z, { scale: footprint * 2.1 });
    e.emit('blast.dust', x, floorY + 0.12, z, {
      count: (small ? 6 : 16) * Math.pow(s, 0.6) * en,
      pattern: 'disc',
      direction: [0, 1, 0],
      spread: 0.15,
      speed: 0.7 + 0.5 * k,
      scale: 0.55 + 0.6 * s,
      radius: R * 0.1,
    });
  }

  return {
    intensity: (small ? 14 : 26) * R * R * en,
    decay: small ? 0.07 : 0.1 + 0.05 * s,
    color: [1, 0.55, 0.22],
    range: R * 5,
  };
}
