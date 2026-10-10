/** Scene settings applied to the live world: gravity, step rate and sub-steps, solver iterations, air drag, ground. */
import RAPIER from '@dimforge/rapier3d-compat';
import type { SceneSettings } from '../../model/types';
import { GROUND_GROUPS } from './bodyFields';
import { registerGround, unregisterGround } from './events';
import { piecesOf } from './soft';
import type { WorldState } from './state';
import { engineDt } from './stepping';
import { rv } from './util';

export function applySettings(s: WorldState, next: SceneSettings, initial = false): void {
  const prev = s.settings;
  s.settings = next;
  const gravityChanged =
    !initial &&
    (prev.gravity[0] !== next.gravity[0] || prev.gravity[1] !== next.gravity[1] || prev.gravity[2] !== next.gravity[2]);
  s.world.gravity = rv(next.gravity);
  // Sleeping bodies would otherwise ignore the new gravity until something touches them.
  if (gravityChanged) {
    for (const r of s.order) r.rb.wakeUp();
    for (const r of s.softOrder) for (const b of piecesOf(s, r)) b.wakeUp();
  }
  s.world.integrationParameters.dt = engineDt(s);
  s.world.integrationParameters.numSolverIterations = next.solverIterations;
  // -- SH: the engine's default contact prediction distance is 2 cm, wide enough that a ball rolling over a surface
  // made of several convex pieces (stairs, ramps, half-pipes, tiled floors) catches on the seams between them and
  // loses a third of its speed; 2 mm keeps 97 % (tests/seams.test.ts). --
  s.world.integrationParameters.normalizedPredictionDistance = 0.002;
  if (initial || prev.ground !== next.ground) buildGround(s);
  // A new seed in the settings restarts the random stream (the initial seed is applied by the constructor).
  if (!initial && prev.seed !== next.seed) s.rng.seed(next.seed);
  if (prev.airDrag !== next.airDrag) {
    for (const r of s.order)
      if (r.def.bodyType === 'dynamic') r.rb.setLinearDamping(r.def.linearDamping + next.airDrag);
  }
}

function buildGround(s: WorldState): void {
  if (s.ground) {
    unregisterGround(s);
    s.world.removeRigidBody(s.ground.body);
    s.ground = null;
    s.queriesDirty = true;
  }
  const g = s.settings.ground;
  if (!g.enabled) return;
  const body = s.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -1, 0));
  const col = s.world.createCollider(
    RAPIER.ColliderDesc.cuboid(g.halfSize, 1, g.halfSize)
      .setFriction(g.friction)
      .setRestitution(g.restitution)
      .setCollisionGroups(GROUND_GROUPS)
      .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Average)
      .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max),
    body,
  );
  s.ground = { body, col };
  registerGround(s);
  s.queriesDirty = true;
}
