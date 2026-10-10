/**
 * The emitter: turns "emit this type here" into particles in the pools.
 *
 * Determinism. Every `emit` call draws from its own random stream, seeded from the scene seed and the number of the
 * call (`mixSeed(seed, emitIndex)`), so the result of a call depends only on the seed, its position in the sequence
 * of calls and its arguments — never on what other calls did with the generator, on how long earlier particles live,
 * or on whether an earlier call was skipped (a skipped call still counts, see `skip()`). The same scene seed and the
 * same sequence of emits therefore always produce the same particles (`tests/fxParticles.test.ts`).
 */
import { Rng } from '../../core/rng';
import type { Vec3 } from '../../core/math';
import type { ParticlePool } from './particlePool';
import { S } from './particlePool';
import { hexToLinear, type ParticleTypeTable } from './particleTypes';

export type EmitPattern = 'cone' | 'sphere' | 'disc';

export interface EmitOptions {
  /** Expected number of particles before the quality tier and the intensity setting scale it (default: the type's). */
  count?: number;
  /** Multiplies particle size (default 1). */
  scale?: number;
  /** Multiplies particle speed (default 1). */
  speed?: number;
  /** Multiplies lifetime (default 1). */
  life?: number;
  /** Axis of the emission cone / normal of the disc (default up). */
  direction?: Vec3;
  /** Half-angle of the cone, radians (default: the type's). */
  spread?: number;
  /** 'cone' (default), 'sphere' (every direction) or 'disc' (outward in the plane ⟂ direction). */
  pattern?: EmitPattern;
  /** Velocity of the thing that emits; a fraction (the type's `inherit`) is added to every particle. */
  velocity?: Vec3;
  /** Tint multiplied onto the type's colour: linear RGB, or a '#rrggbb' string (sRGB). */
  color?: Vec3 | string;
  /** Opacity multiplier (default 1). */
  alpha?: number;
  /** Spawn radius, metres (default: the type's). */
  radius?: number;
}

/** A 32-bit mix of the scene seed and a call number (murmur-style finaliser). */
export function mixSeed(seed: number, index: number): number {
  let h = (seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

const WHITE: Vec3 = [1, 1, 1];

export class ParticleEmitter {
  /** The scene seed the streams derive from. */
  seed = 1;
  /** Number of `emit` / `skip` calls since the last `reseed`. */
  emitIndex = 0;
  /** Multiplies every count (quality tier × intensity setting). */
  emission = 1;
  /** Multiplies every size (a mild function of the intensity setting). */
  sizeScale = 1;
  private readonly rng = new Rng(1);

  constructor(
    private readonly table: ParticleTypeTable,
    private readonly additive: ParticlePool,
    private readonly normal: ParticlePool,
  ) {}

  /** Restart the streams: the next emit is call number 0 of a world with this seed. */
  reseed(seed: number): void {
    this.seed = seed >>> 0;
    this.emitIndex = 0;
  }

  /** Count a call that was not carried out (culled, rate-limited) so later calls keep their streams. */
  skip(): void {
    this.emitIndex++;
  }

  /** Emit particles of a registered type. Returns how many were created (0 for an unknown type). */
  emit(type: string, x: number, y: number, z: number, o: EmitOptions = {}): number {
    const t = this.table.get(type);
    const index = this.emitIndex++;
    if (!t) return 0;
    const def = t.def;
    const rng = this.rng;
    rng.state = mixSeed(this.seed, index);

    const expected = Math.max(0, (o.count ?? def.count) * this.emission);
    let n = Math.floor(expected);
    if (rng.next() < expected - n) n++;
    if (n === 0) return 0;

    const pool = def.blend === 'additive' ? this.additive : this.normal;
    const scale = (o.scale ?? 1) * this.sizeScale;
    const speedK = o.speed ?? 1;
    const lifeK = o.life ?? 1;
    const spread = o.spread ?? def.spread;
    const radius = o.radius ?? def.radius;
    const pattern = o.pattern ?? 'cone';
    const alpha = o.alpha ?? 1;
    const inherit = def.inherit ?? 0;
    const ivx = (o.velocity?.[0] ?? 0) * inherit;
    const ivy = (o.velocity?.[1] ?? 0) * inherit;
    const ivz = (o.velocity?.[2] ?? 0) * inherit;

    // Axis and an orthonormal basis (u, w) perpendicular to it.
    let ax = 0;
    let ay = 1;
    let az = 0;
    if (o.direction) {
      const l = Math.hypot(o.direction[0], o.direction[1], o.direction[2]);
      if (l > 1e-9) {
        ax = o.direction[0] / l;
        ay = o.direction[1] / l;
        az = o.direction[2] / l;
      }
    }
    let ux: number, uy: number, uz: number;
    if (Math.abs(ay) < 0.9) {
      // u = normalize(axis × up)
      const l = Math.hypot(az, ax);
      ux = az / l;
      uy = 0;
      uz = -ax / l;
    } else {
      // u = normalize(axis × right)
      const l = Math.hypot(ay, az);
      ux = 0;
      uy = az / l;
      uz = -ay / l;
    }
    // w = axis × u
    const wx = ay * uz - az * uy;
    const wy = az * ux - ax * uz;
    const wz = ax * uy - ay * ux;

    const tint = typeof o.color === 'string' ? (hexToLinear(o.color) ?? WHITE) : (o.color ?? WHITE);
    const [tr, tg, tb] = tint;

    const cosMax = Math.cos(Math.min(Math.PI, Math.max(0, spread)));
    const st = pool.state;
    const frames = t.frames;
    for (let k = 0; k < n; k++) {
      // Direction.
      let dx: number, dy: number, dz: number;
      const phi = rng.next() * 6.283185307179586;
      const cp = Math.cos(phi);
      const sp = Math.sin(phi);
      if (pattern === 'sphere') {
        const c = rng.next() * 2 - 1;
        const s = Math.sqrt(1 - c * c);
        dx = s * cp;
        dy = c;
        dz = s * sp;
      } else if (pattern === 'disc') {
        // In the plane ⟂ axis, tilted out of it by up to the spread.
        const tilt = (rng.next() * 2 - 1) * Math.min(spread, 1.2);
        const ct = Math.cos(tilt);
        dx = ct * (cp * ux + sp * wx) + Math.sin(tilt) * ax;
        dy = ct * (cp * uy + sp * wy) + Math.sin(tilt) * ay;
        dz = ct * (cp * uz + sp * wz) + Math.sin(tilt) * az;
      } else {
        const c = 1 - rng.next() * (1 - cosMax); // uniform over the cap
        const s = Math.sqrt(Math.max(0, 1 - c * c));
        dx = c * ax + s * (cp * ux + sp * wx);
        dy = c * ay + s * (cp * uy + sp * wy);
        dz = c * az + s * (cp * uz + sp * wz);
      }
      // Position: inside a sphere of `radius` (a disc for the disc pattern).
      let px = x;
      let py = y;
      let pz = z;
      if (radius > 0) {
        const rr = radius * Math.cbrt(rng.next());
        if (pattern === 'disc') {
          const r2 = radius * Math.sqrt(rng.next());
          px += r2 * (cp * ux + sp * wx);
          py += r2 * (cp * uy + sp * wy);
          pz += r2 * (cp * uz + sp * wz);
        } else {
          const c = rng.next() * 2 - 1;
          const s = Math.sqrt(1 - c * c);
          const a = rng.next() * 6.283185307179586;
          px += rr * s * Math.cos(a);
          py += rr * c;
          pz += rr * s * Math.sin(a);
        }
      }
      const speed = (def.speed[0] + (def.speed[1] - def.speed[0]) * rng.next()) * speedK;
      const life = (def.life[0] + (def.life[1] - def.life[0]) * rng.next()) * lifeK;
      const size = (def.size[0] + (def.size[1] - def.size[0]) * rng.next()) * scale;
      const spin = (def.spin[0] + (def.spin[1] - def.spin[0]) * rng.next()) * (rng.next() < 0.5 ? -1 : 1);
      const frame = frames[Math.min(frames.length - 1, Math.floor(rng.next() * frames.length))];
      const rot = rng.next() * 6.283185307179586;
      const phase = rng.next();

      const o2 = pool.alloc();
      st[o2 + S.px] = px;
      st[o2 + S.py] = py;
      st[o2 + S.pz] = pz;
      st[o2 + S.vx] = dx * speed + ivx;
      st[o2 + S.vy] = dy * speed + ivy;
      st[o2 + S.vz] = dz * speed + ivz;
      st[o2 + S.age] = 0;
      st[o2 + S.life] = life;
      st[o2 + S.size] = size;
      st[o2 + S.rot] = rot;
      st[o2 + S.spin] = spin;
      st[o2 + S.phase] = phase;
      st[o2 + S.alpha] = alpha;
      st[o2 + S.tr] = tr;
      st[o2 + S.tg] = tg;
      st[o2 + S.tb] = tb;
      st[o2 + S.type] = t.slot;
      st[o2 + S.frame] = frame;
      st[o2 + S.settled] = 0;
    }
    return n;
  }
}
