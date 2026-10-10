/** Simulation-only interactions: firing projectiles, setting off blasts, and soft-particle lookup for grabbing. */
import type { Vector3 } from 'three';
import { qfromEuler, qfromUnitVectors, type Quat, type Vec3 } from '../core/math';
import { createBody } from '../model/factory';
import type { App } from './app';
import { PROJECTILE_TAG } from './fx/bodyFx';
import { projectileRecipe, projectileType } from './projectileTypes';

/** Charge multiplier of a held throw: a tap (< 180 ms) is 1×, holding builds up to 2.5× over 1.5 s. */
export function chargePower(heldMs: number): number {
  return heldMs < 180 ? 1 : 1 + 1.5 * Math.min(1, (heldMs - 180) / 1500);
}

export class Projectiles {
  constructor(private app: App) {}

  /** Launch speed (m/s) and flight parameters the current options give a shot at `power`× charge. */
  shotSetup(power = 1): { speed: number; damping: number; gravityScale: number; mass: number | null } {
    const p = this.app.prefs.value;
    const type = projectileType(p.shootType);
    const r = projectileRecipe(type, p.shootSize, p.shootSpeed, p.shootMass);
    return { speed: r.speed * power, damping: type.linearDamping, gravityScale: 1, mass: r.mass };
  }

  shoot(origin: Vector3, dir: Vector3, power = 1): void {
    const { app } = this;
    if (!app.sim.active) {
      app.toast('Start the simulation to fire projectiles', 'warn');
      return;
    }
    const p = app.prefs.value;
    const type = projectileType(p.shootType);
    const r = projectileRecipe(type, p.shootSize, p.shootSpeed, p.shootMass);
    const speed = r.speed * power;
    const d: Vec3 = [dir.x, dir.y, dir.z];
    const rotation: Quat = type.aligned ? qfromUnitVectors([0, 1, 0], d) : qfromEuler([0, 0, 0]);
    const b = createBody({
      name: type.id === 'ball' ? 'Projectile' : type.label,
      shape: r.init.shape,
      position: [origin.x + dir.x * 1.2, origin.y + dir.y * 1.2, origin.z + dir.z * 1.2],
      material: r.init.material,
      velocity: [dir.x * speed, dir.y * speed, dir.z * speed],
      linearDamping: r.init.linearDamping,
      ccd: true,
      rotation,
      tags: [PROJECTILE_TAG], // ── FX: the effects give a hard projectile hit a small blast ──
      ...(r.mass !== null ? { massOverride: r.mass } : {}),
    });
    app.sim.spawn(b);
    app.audioDirector.launch(b.position, speed, r.radius * 2); // ── FX: the report of the shot ──
    if (type.fuse) setTimeout(() => this.detonate(b.id), type.fuse * 1000);
  }

  /** Blow up a fused projectile where it is now (no-op when the simulation was reset meanwhile). */
  private detonate(id: string): void {
    const { app } = this;
    if (!app.sim.active || !app.sim.ephemeral.has(id)) return;
    const view = app.bodies.get(id);
    if (!view) return;
    const at = view.position.clone();
    app.sim.ephemeral.delete(id);
    app.sim.client.op({ op: 'remove', ids: [id] });
    app.sim.client.op({ op: 'explode', center: [at.x, at.y, at.z], strength: 90, radius: 6 });
    app.effects.shockwave(at, 6);
  }

  /**
   * Set off a blast with the tool's options (kind, falloff curve, radius, strength). `scale` multiplies the strength
   * (a gust sends many small ones while the button is held); `quiet` skips the visual burst.
   */
  blast(at: Vector3, dir?: Vector3, scale = 1, quiet = false): void {
    const { app } = this;
    if (!app.sim.active) {
      app.toast('Start the simulation to set off blasts', 'warn');
      return;
    }
    const p = app.prefs.value;
    app.sim.client.op({
      op: 'explode',
      center: [at.x, at.y, at.z],
      strength: p.blastStrength * scale,
      radius: p.blastRadius,
      kind: p.blastKind,
      falloff: p.blastFalloff,
      dir: dir ? [dir.x, dir.y, dir.z] : undefined,
    });
    if (quiet) return;
    // ── FX: a particle explosion; the wireframe shock wave remains when effects are off ──
    if (!app.fxDirector.blast(at, p.blastRadius, p.blastStrength)) app.effects.shockwave(at, p.blastRadius);
    app.audioDirector.explosion([at.x, at.y, at.z], p.blastRadius, p.blastStrength); // ── FX: the sound is independent of the visual switch ──
  }

  /** Index (within the entity's particle block) of the soft particle closest to a world point. */
  softParticleAt(id: string, point: Vector3): number {
    const pos = this.app.sim.client.softOf(id);
    if (!pos) return -1;
    let best = -1,
      bd = Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      const dx = pos[i] - point.x,
        dy = pos[i + 1] - point.y,
        dz = pos[i + 2] - point.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bd) {
        bd = d;
        best = i / 3;
      }
    }
    return best;
  }
}
