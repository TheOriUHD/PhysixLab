/**
 * World bounds (ZN-34): the playfield box of `SceneSettings.bounds`.
 *
 * Each of the six faces has an *edge* (`open`, `kill`, `soft`, `water`):
 *
 *  - **soft** faces are spring walls. From `margin` metres inside the face a dynamic body feels an acceleration
 *    `a = −k·depth` toward the inside and, while it moves outward, `−c·v_out` (k = `stiffness`, c = `damping`), applied
 *    as an impulse `m·a·dt` before every step. A body thrown at the wall decelerates smoothly and comes back; an
 *    undamped one stops after `v/√k` metres. Nothing is ever lost at a soft face.
 *  - **kill** and **water** faces lose a dynamic body whose centre passes them — a kill box or, with the floor, a kill
 *    plane; `water` is the same but reported as drowned and drawn as a sea. What "lose" means is the policy: `kill`
 *    removes the body (a simulation-only body is deleted, a body of the scene switched off until Reset); `respawn`
 *    puts it back at its starting pose or its last checkpoint — after a delay, with a time penalty on the racer's clock
 *    and points off the score, at most `respawn.max` times — see `ZoneSystem.lose`.
 *  - **open** faces do nothing (the engine still switches bodies off 400 m below the origin).
 *
 * Disabled bounds cost nothing: both hooks return at once.
 */
import type { Vec3 } from '../../core/math';
import type { BoundsSettings } from '../../model/types';
import { BOUNDS_EVENT_TYPE } from '../../model/zones';
import type { WorldState } from './state';

/** The six faces: the axis, and +1 for the face at `max`, −1 for the face at `min`. */
const FACES: readonly { key: keyof BoundsSettings['edges']; axis: 0 | 1 | 2; sign: 1 | -1 }[] = [
  { key: 'nx', axis: 0, sign: -1 },
  { key: 'px', axis: 0, sign: 1 },
  { key: 'ny', axis: 1, sign: -1 },
  { key: 'py', axis: 1, sign: 1 },
  { key: 'nz', axis: 2, sign: -1 },
  { key: 'pz', axis: 2, sign: 1 },
];

type Face = (typeof FACES)[number];
/** The faces of each kind for one settings object (settings objects are immutable: an edit makes a new one). */
const faceCache = new WeakMap<BoundsSettings, { soft: Face[]; killing: Face[] }>();
function facesOf(b: BoundsSettings): { soft: Face[]; killing: Face[] } {
  let c = faceCache.get(b);
  if (!c) {
    c = {
      soft: FACES.filter((f) => b.edges[f.key] === 'soft'),
      killing: FACES.filter((f) => b.edges[f.key] === 'kill' || b.edges[f.key] === 'water'),
    };
    faceCache.set(b, c);
  }
  return c;
}

/** Distance from the point to the face, positive inside the box (negative once the point is past the face). */
const depthInside = (b: BoundsSettings, axis: 0 | 1 | 2, sign: 1 | -1, p: number): number =>
  sign > 0 ? b.max[axis] - p : p - b.min[axis];

/** Soft walls: push dynamic bodies back from the soft faces (called before every step). */
export function applySoftWalls(s: WorldState, dt: number): void {
  const b = s.settings.bounds;
  if (!b.enabled) return;
  const { soft } = facesOf(b);
  if (!soft.length) return;
  const { margin, stiffness, damping } = b.soft;
  for (const r of s.order) {
    if (r.disabled || r.def.bodyType !== 'dynamic') continue;
    const t = r.rb.translation();
    const p: Vec3 = [t.x, t.y, t.z];
    let impulse: Vec3 | null = null;
    for (const f of soft) {
      const inside = depthInside(b, f.axis, f.sign, p[f.axis]);
      if (inside >= margin) continue;
      const depth = margin - inside;
      const v = r.rb.linvel();
      const vOut = (f.axis === 0 ? v.x : f.axis === 1 ? v.y : v.z) * f.sign;
      // acceleration toward the inside of the box
      let a = stiffness * depth;
      if (vOut > 0) a += damping * vOut;
      impulse ??= [0, 0, 0];
      impulse[f.axis] -= f.sign * r.mass * a * dt;
    }
    if (impulse) r.rb.applyImpulse({ x: impulse[0], y: impulse[1], z: impulse[2] }, true);
  }
}

/** Kill and water faces: lose the dynamic bodies that went past them (called after every step). */
export function checkBounds(s: WorldState): void {
  const b = s.settings.bounds;
  if (!b.enabled) return;
  const { killing } = facesOf(b);
  if (!killing.length) return;
  const zones = s.host.zones;
  for (const r of s.order) {
    if (r.disabled || r.def.bodyType !== 'dynamic') continue;
    const t = r.rb.translation();
    const p: Vec3 = [t.x, t.y, t.z];
    for (const f of killing) {
      if (depthInside(b, f.axis, f.sign, p[f.axis]) >= 0) continue;
      const water = b.edges[f.key] === 'water';
      const respawn = b.policy === 'respawn' && !r.ephemeral;
      zones.lose(r.id, {
        mode: respawn ? 'respawn' : 'remove',
        to: b.respawn.to,
        delay: b.respawn.delay,
        penalty: b.respawn.penaltySeconds,
        penaltyPoints: b.respawn.penaltyPoints,
        max: b.respawn.max,
        cause: water ? 'drowned' : 'bounds',
        group: b.respawn.wholeGroups,
        source: { owner: r.id, component: '', type: BOUNDS_EVENT_TYPE, zone: 'World bounds' },
      });
      break;
    }
  }
}
