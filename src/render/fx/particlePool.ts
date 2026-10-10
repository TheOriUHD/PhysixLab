/**
 * The particle pool: a fixed-capacity structure-of-arrays simulation with no allocation after construction.
 *
 * Particles live densely in `state` (`S` floats each). Killing one moves the last particle into its place, so the
 * live range is always `0 … count−1`. Spawning into a full pool overwrites a victim chosen by a rotating cursor
 * (the newest effects always show; which old particle disappears is deterministic). `limit` is the soft cap the
 * quality tier sets (≤ `capacity`).
 *
 * `update(dt, env)` integrates gravity (the scene's gravity vector times the type's multiplier), drag, wind, a
 * little lateral wobble, spin and the floor. `writeInstances()` evaluates the over-life curves and fills the four
 * instance arrays the GPU reads (position, velocity, size / rotation / frame / mode, colour). They are plain typed
 * arrays — this module has no three.js dependency, so pooling, caps and determinism are unit-tested in Node.
 */
import { LUT_CH, LUT_N, P, type ParticleTypeTable } from './particleTypes';

/** Floats per particle in `state`. */
export const S = {
  px: 0,
  py: 1,
  pz: 2,
  vx: 3,
  vy: 4,
  vz: 5,
  age: 6,
  life: 7,
  size: 8,
  rot: 9,
  spin: 10,
  phase: 11,
  alpha: 12,
  tr: 13,
  tg: 14,
  tb: 15,
  type: 16,
  frame: 17,
  settled: 18,
  STRIDE: 19,
} as const;

/** What the pool needs to know about the world each step. */
export interface ParticleEnv {
  gravity: readonly [number, number, number];
  /** Constant wind velocity, m/s. */
  wind: readonly [number, number, number];
  /** Optional wind field sampled at a particle's position (overrides `wind` for types with wind > 0). */
  windAt?: (x: number, y: number, z: number, out: [number, number, number]) => void;
  /** Height of the floor particles bounce on; −Infinity when there is none. */
  floorY: number;
}

export interface PoolStats {
  spawned: number;
  /** Particles that replaced a live one because the pool was full. */
  overwritten: number;
  expired: number;
}

const scratchWind: [number, number, number] = [0, 0, 0];

export class ParticlePool {
  readonly state: Float32Array;
  /** Instance arrays (GPU layout), valid for `0 … count−1` after `writeInstances`. */
  readonly iPos: Float32Array;
  readonly iVel: Float32Array;
  readonly iData: Float32Array;
  readonly iColor: Float32Array;
  count = 0;
  /** Soft cap (≤ capacity). Lowering it below `count` culls the excess at the next `update`. */
  limit: number;
  readonly stats: PoolStats = { spawned: 0, overwritten: 0, expired: 0 };
  private cursor = 0;
  private readonly keys: Float64Array;
  private readonly order: Uint32Array;

  constructor(
    readonly capacity: number,
    private readonly table: ParticleTypeTable,
  ) {
    if (capacity > 65535) throw new Error('A particle pool holds at most 65535 particles');
    this.state = new Float32Array(capacity * S.STRIDE);
    this.iPos = new Float32Array(capacity * 3);
    this.iVel = new Float32Array(capacity * 3);
    this.iData = new Float32Array(capacity * 4);
    this.iColor = new Float32Array(capacity * 4);
    this.keys = new Float64Array(capacity);
    this.order = new Uint32Array(capacity);
    this.limit = capacity;
  }

  /** Reserve a slot for a new particle and return its offset into `state` (the caller fills the fields). */
  alloc(): number {
    this.stats.spawned++;
    const cap = Math.max(1, Math.min(this.limit, this.capacity));
    let i: number;
    if (this.count < cap) i = this.count++;
    else {
      // Full: replace the particle under the cursor, which advances through the pool.
      if (this.count > cap) this.count = cap;
      this.cursor = (this.cursor + 1) % this.count;
      i = this.cursor;
      this.stats.overwritten++;
    }
    return i * S.STRIDE;
  }

  /** Remove every particle. */
  clear(): void {
    this.count = 0;
    this.cursor = 0;
  }

  private remove(i: number): void {
    const last = --this.count;
    if (i !== last) this.state.copyWithin(i * S.STRIDE, last * S.STRIDE, (last + 1) * S.STRIDE);
  }

  update(dt: number, env: ParticleEnv): void {
    if (dt <= 0 || this.count === 0) return;
    // Large frames are integrated in a few equal sub-steps so a hitch does not make a spark tunnel through the floor.
    const n = dt > 0.05 ? Math.min(4, Math.ceil(dt / 0.05)) : 1;
    const h = dt / n;
    for (let k = 0; k < n; k++) this.step(h, env);
  }

  private step(dt: number, env: ParticleEnv): void {
    this.table.sync();
    const st = this.state;
    const params = this.table.params;
    const [gx, gy, gz] = env.gravity;
    const [wx0, wy0, wz0] = env.wind;
    const floorY = env.floorY;
    const windAt = env.windAt;
    // Over-limit culling: drop the excess (oldest first by index — deterministic).
    while (this.count > this.limit) this.remove(this.count - 1);
    for (let i = 0; i < this.count;) {
      const o = i * S.STRIDE;
      const age = st[o + S.age] + dt;
      if (age >= st[o + S.life]) {
        this.remove(i);
        this.stats.expired++;
        continue;
      }
      st[o + S.age] = age;
      if (st[o + S.settled] !== 0) {
        i++;
        continue;
      }
      const po = st[o + S.type] * P.STRIDE;
      let vx = st[o + S.vx];
      let vy = st[o + S.vy];
      let vz = st[o + S.vz];
      let x = st[o + S.px];
      let y = st[o + S.py];
      let z = st[o + S.pz];

      const g = params[po + P.gravity];
      vx += gx * g * dt;
      vy += gy * g * dt;
      vz += gz * g * dt;

      const wind = params[po + P.wind];
      let wx = 0;
      let wy = 0;
      let wz = 0;
      if (wind > 0) {
        if (windAt) {
          windAt(x, y, z, scratchWind);
          wx = scratchWind[0] * wind;
          wy = scratchWind[1] * wind;
          wz = scratchWind[2] * wind;
        } else {
          wx = wx0 * wind;
          wy = wy0 * wind;
          wz = wz0 * wind;
        }
      }
      const drag = params[po + P.drag];
      if (drag > 0) {
        const k = Math.exp(-drag * dt);
        vx = wx + (vx - wx) * k;
        vy = wy + (vy - wy) * k;
        vz = wz + (vz - wz) * k;
      } else if (wind > 0) {
        // No drag: the wind still pushes (acceleration towards its velocity).
        const k = 1 - Math.exp(-wind * 2 * dt);
        vx += (wx - vx) * k;
        vy += (wy - vy) * k;
        vz += (wz - vz) * k;
      }
      const swirl = params[po + P.swirl];
      if (swirl !== 0) {
        const ph = age * 3.1 + st[o + S.phase] * 6.2831853;
        vx += Math.cos(ph) * swirl * dt;
        vz += Math.sin(ph * 1.37) * swirl * dt;
      }

      x += vx * dt;
      y += vy * dt;
      z += vz * dt;

      const bounce = params[po + P.bounce];
      if (bounce > 0 && floorY > -Infinity) {
        const rest = st[o + S.size] * 0.22;
        if (y < floorY + rest) {
          y = floorY + rest;
          if (vy < 0) {
            vy = -vy * bounce;
            const f = params[po + P.friction];
            vx *= f;
            vz *= f;
            st[o + S.spin] *= 0.6;
            if (vy < 0.5 + 1.2 * rest) {
              // Come to rest. Types with `settle` then lie flat on the floor until they expire.
              vx *= 0.3;
              vz *= 0.3;
              if (vx * vx + vz * vz < 0.25) {
                if (params[po + P.settle] !== 0) st[o + S.settled] = 1;
                vx = vy = vz = 0;
                st[o + S.spin] = 0;
              }
            }
          }
        }
      }

      st[o + S.vx] = vx;
      st[o + S.vy] = vy;
      st[o + S.vz] = vz;
      st[o + S.px] = x;
      st[o + S.py] = y;
      st[o + S.pz] = z;
      st[o + S.rot] += st[o + S.spin] * dt;
      i++;
    }
  }

  /**
   * Fill the instance arrays from the simulation state. `order` (from `sortBackToFront`) gives the draw order, or
   * null for the pool's own order (fine for additive blending, which is commutative).
   */
  writeInstances(order: Uint32Array | null): void {
    this.table.sync();
    const st = this.state;
    const lut = this.table.lut;
    const params = this.table.params;
    const n = this.count;
    for (let k = 0; k < n; k++) {
      const i = order ? order[k] : k;
      const o = i * S.STRIDE;
      const t = st[o + S.age] / st[o + S.life];
      const type = st[o + S.type];
      const lo = type * LUT_CH * LUT_N;
      // Linear interpolation in the look-up tables.
      const f = (t < 0 ? 0 : t > 1 ? 1 : t) * (LUT_N - 1);
      const i0 = Math.min(LUT_N - 2, Math.floor(f));
      const fr = f - i0;
      const a = lo + i0;
      const sizeM = lut[a] + (lut[a + 1] - lut[a]) * fr;
      const alphaM = lut[a + LUT_N] + (lut[a + LUT_N + 1] - lut[a + LUT_N]) * fr;
      const r = lut[a + 2 * LUT_N] + (lut[a + 2 * LUT_N + 1] - lut[a + 2 * LUT_N]) * fr;
      const g = lut[a + 3 * LUT_N] + (lut[a + 3 * LUT_N + 1] - lut[a + 3 * LUT_N]) * fr;
      const b = lut[a + 4 * LUT_N] + (lut[a + 4 * LUT_N + 1] - lut[a + 4 * LUT_N]) * fr;

      const po = type * P.STRIDE;
      const orient = params[po + P.orient];
      const settled = st[o + S.settled] !== 0;
      // Mode code in iData.w: > 0 velocity streak (extra length per m/s), −1 flat on the ground, 0 billboard.
      const mode =
        settled && params[po + P.settle] !== 0
          ? -1
          : orient === 1
            ? params[po + P.stretch] || 0.02
            : orient === 2
              ? -1
              : 0;

      const p3 = k * 3;
      this.iPos[p3] = st[o + S.px];
      this.iPos[p3 + 1] = st[o + S.py];
      this.iPos[p3 + 2] = st[o + S.pz];
      this.iVel[p3] = st[o + S.vx];
      this.iVel[p3 + 1] = st[o + S.vy];
      this.iVel[p3 + 2] = st[o + S.vz];
      const d4 = k * 4;
      this.iData[d4] = st[o + S.size] * sizeM;
      this.iData[d4 + 1] = st[o + S.rot];
      // The sprite cell, +32 for types that fade out near the floor (decoded in the vertex shader).
      this.iData[d4 + 2] = st[o + S.frame] + (params[po + P.softFloor] !== 0 ? 32 : 0);
      this.iData[d4 + 3] = mode;
      this.iColor[d4] = r * st[o + S.tr];
      this.iColor[d4 + 1] = g * st[o + S.tg];
      this.iColor[d4 + 2] = b * st[o + S.tb];
      this.iColor[d4 + 3] = alphaM * st[o + S.alpha];
    }
  }

  /**
   * The draw order for alpha blending: indices of the live particles, farthest from (cx, cy, cz) first. Allocation-
   * free: the distances are packed with the index into one float64 key and sorted as numbers.
   */
  sortBackToFront(cx: number, cy: number, cz: number): Uint32Array {
    const n = this.count;
    const st = this.state;
    const keys = this.keys;
    for (let i = 0; i < n; i++) {
      const o = i * S.STRIDE;
      const dx = st[o + S.px] - cx;
      const dy = st[o + S.py] - cy;
      const dz = st[o + S.pz] - cz;
      const d = Math.min(4e9, (dx * dx + dy * dy + dz * dz) * 4);
      keys[i] = Math.floor(d) * 65536 + i;
    }
    keys.subarray(0, n).sort();
    const order = this.order;
    for (let k = 0; k < n; k++) order[k] = keys[n - 1 - k] % 65536;
    return order;
  }

  /** The over-life evaluation of one particle, for tests and tools: [sizeMultiplier, alpha, r, g, b]. */
  curveAt(typeSlot: number, t: number, out: Float32Array | number[] = new Float32Array(5)): Float32Array | number[] {
    this.table.sync();
    const lut = this.table.lut;
    const f = Math.min(1, Math.max(0, t)) * (LUT_N - 1);
    const i0 = Math.min(LUT_N - 2, Math.floor(f));
    const fr = f - i0;
    for (let c = 0; c < LUT_CH; c++) {
      const a = typeSlot * LUT_CH * LUT_N + c * LUT_N + i0;
      out[c] = lut[a] + (lut[a + 1] - lut[a]) * fr;
    }
    return out;
  }
}
