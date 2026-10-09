/**
 * The physics world, split by concern. `PhysicsWorld` (physicsWorld.ts) is the façade; everything else
 * is a set of functions over the shared `WorldState` (state.ts):
 *
 *   rapier.ts     one-time WASM initialisation
 *   state.ts      WorldState + body / joint / soft records
 *   colliders.ts  shape → collider description
 *   bodies.ts     rigid-body construction
 *   joints.ts     joint construction, motors, per-joint measurement and spring breakage
 *   soft.ts       soft-body construction / removal / grab spring / particle readback
 *   settings.ts   gravity, step rate, solver iterations, air drag, ground plane
 *   edits.ts      live edits: remove, update (in place or rebuild), teleport, set velocity
 *   forces.ts     thrusters, grab spring, impulse, explosion
 *   ops.ts        SimOp dispatch
 *   stepping.ts   fixed-step accumulator, pre/post step hooks, manual stepping
 *   readback.ts   poses, joint state, contacts, events
 *   energy.ts     kinetic / rotational / potential / elastic energy and momentum
 *   stats.ts      build info, run-time statistics, test lookups
 */
export { PhysicsWorld } from './physicsWorld';
export { initRapier } from './rapier';
export type { BodyRec, JointRec, SoftRec } from './state';
