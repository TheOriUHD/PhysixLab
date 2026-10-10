/** Simulation-only interactions: firing projectiles, setting off blasts, and soft-particle lookup for grabbing. */
import type { Vector3 } from 'three';
import { qfromEuler } from '../core/math';
import { createBody } from '../model/factory';
import type { App } from './app';
import { PROJECTILE_TAG } from './fx/bodyFx';

export class Projectiles {
  constructor(private app: App) {}

  shoot(origin: Vector3, dir: Vector3): void {
    const { app } = this;
    if (!app.sim.active) {
      app.toast('Start the simulation to fire projectiles', 'warn');
      return;
    }
    const p = app.prefs.value;
    const r = p.shootSize;
    const b = createBody({
      name: 'Projectile',
      shape: { type: 'sphere', size: [r * 2, r * 2, r * 2] },
      position: [origin.x + dir.x * 1.2, origin.y + dir.y * 1.2, origin.z + dir.z * 1.2],
      material: { preset: 'steel', color: '#ffb347', metalness: 0.5 },
      velocity: [dir.x * p.shootSpeed, dir.y * p.shootSpeed, dir.z * p.shootSpeed],
      ccd: true,
      rotation: qfromEuler([0, 0, 0]),
      tags: [PROJECTILE_TAG], // ── FX: the effects give a hard projectile hit a small blast ──
    });
    app.sim.spawn(b);
  }

  blast(at: Vector3): void {
    const { app } = this;
    if (!app.sim.active) {
      app.toast('Start the simulation to set off blasts', 'warn');
      return;
    }
    const p = app.prefs.value;
    app.sim.client.op({ op: 'explode', center: [at.x, at.y, at.z], strength: p.blastStrength, radius: 7 });
    // ── FX: a particle explosion; the wireframe shock wave remains when effects are off ──
    if (!app.fxDirector.blast(at, 7, p.blastStrength)) app.effects.shockwave(at, 7);
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
