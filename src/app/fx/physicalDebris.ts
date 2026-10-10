/**
 * Physical debris (FX-6): a few real rigid fragments thrown out of the hardest hits on brittle materials, when the
 * user asks for them. They are ordinary simulation-only bodies (like projectiles), so they collide, roll and can be
 * knocked about — which is why the feature is off by default, capped by the quality tier and cleaned up: a fragment
 * is removed from the world after a few simulated seconds, and all of them when the simulation is reset. Fragments
 * collide with everything except each other and never emit effects themselves.
 */
import { Rng } from '../../core/rng';
import type { Vec3 } from '../../core/math';
import { qfromEuler } from '../../core/math';
import { createBody } from '../../model/factory';
import { mixSeed } from '../../render/fx/emitter';
import type { ImpactBurst } from '../../render/fx/surfaces';
import type { SimController } from '../simController';
import { FRAGMENT_TAG } from './bodyFx';

/** Group 1, accepting every group but 1: fragments pass through each other and collide with the rest. */
const FRAGMENT_COLLISION = { group: 1, mask: 0xffff & ~(1 << 1) };

/** Fragments per burst at most. */
const PER_BURST = 6;

export class PhysicalDebris {
  /** Most fragments alive at once (the quality tier sets it). */
  cap = 24;
  private live: { id: string; until: number }[] = [];
  private clock = 0;
  private serial = 0;
  private seed = 1;
  private readonly rng = new Rng(1);

  constructor(private readonly sim: SimController) {}

  get count(): number {
    return this.live.length;
  }

  reseed(seed: number): void {
    this.seed = seed >>> 0;
    this.serial = 0;
  }

  /**
   * Throw fragments of `burst` out of the contact at `point`. `preset` / `color` are the material of the brittle body.
   * Returns how many were created (0 when the cap is reached or there is no simulation).
   */
  spawn(burst: ImpactBurst, preset: string, color: string | undefined, point: Vec3, normal: Vec3): number {
    if (!this.sim.client.active) return 0;
    const room = this.cap - this.live.length;
    const n = Math.min(room, PER_BURST, Math.max(1, Math.ceil(burst.count * 0.45)));
    if (n <= 0) return 0;
    const rng = this.rng;
    rng.state = mixSeed(this.seed, this.serial++);
    for (let i = 0; i < n; i++) {
      const size = Math.min(0.25, Math.max(0.04, (0.06 + 0.07 * rng.next()) * burst.scale));
      // Out of the surface, spread into a cone, faster for harder hits.
      const spread = 0.9;
      const ox = (rng.next() * 2 - 1) * spread;
      const oy = (rng.next() * 2 - 1) * spread;
      const oz = (rng.next() * 2 - 1) * spread;
      const speed = (2 + 3 * rng.next()) * burst.speed;
      const dir: Vec3 = [normal[0] * burst.dir + ox, normal[1] * burst.dir + oy, normal[2] * burst.dir + oz];
      const l = Math.hypot(...dir) || 1;
      const def = createBody({
        name: 'Fragment',
        shape: { type: 'box', size: [size, size * 0.55, size * 0.8] },
        position: [
          point[0] + normal[0] * burst.dir * 0.06 + (rng.next() - 0.5) * 0.08,
          point[1] + normal[1] * burst.dir * 0.06 + 0.03,
          point[2] + normal[2] * burst.dir * 0.06 + (rng.next() - 0.5) * 0.08,
        ],
        rotation: qfromEuler([rng.next() * 6.28, rng.next() * 6.28, rng.next() * 6.28]),
        velocity: [(dir[0] / l) * speed, (dir[1] / l) * speed, (dir[2] / l) * speed],
        angularVelocity: [(rng.next() - 0.5) * 20, (rng.next() - 0.5) * 20, (rng.next() - 0.5) * 20],
        material: color ? { preset, color } : preset,
        collision: { ...FRAGMENT_COLLISION },
        tags: [FRAGMENT_TAG],
      });
      this.sim.spawn(def);
      this.live.push({ id: def.id, until: this.clock + 5 + 4 * rng.next() });
    }
    return n;
  }

  /** Advance the lifetime clock by `dt` simulated seconds and remove the fragments that have expired. */
  update(dt: number): void {
    if (dt > 0) this.clock += dt;
    if (!this.live.length) return;
    const dead = this.live.filter((f) => f.until <= this.clock);
    if (dead.length) this.remove(dead.map((f) => f.id));
  }

  /** The world was reset or replaced: forget the fragments (the world and its ephemeral bodies are already gone). */
  clear(): void {
    this.live = [];
    this.clock = 0;
  }

  private remove(ids: string[]): void {
    const gone = new Set(ids);
    this.live = this.live.filter((f) => !gone.has(f.id));
    if (!this.sim.client.active) return;
    for (const id of ids) this.sim.ephemeral.delete(id);
    this.sim.client.op({ op: 'remove', ids });
    this.sim.emit('layout', undefined);
  }
}
