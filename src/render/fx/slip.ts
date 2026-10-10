/**
 * Ground contact and slip, estimated from a body's pose and velocities alone.
 *
 * The lowest point of the body's shape is the contact patch on the ground. The velocity of that point is
 *
 *     v_c = v + ω × (p_c − x)
 *
 * (centre-of-mass velocity plus the spin carrying the point round), and its horizontal part is the **slip speed**: the
 * speed at which the surface slides over the ground. A wheel rolling without slipping has v_c = 0 (ω·r = v); a wheel
 * spinning on the spot has |v_c| = ω·r; a locked wheel or a box sliding along the floor has v_c = v. That is exactly
 * "slip estimated from wheel velocity vs ground speed", it needs no contact data from the engine, and it works for
 * any shape the registry can describe (`tests/fxSlip.test.ts` checks the cases above analytically and against the
 * engine). The ground is the plane at `floorY` (the ground slab's top); bodies on other bodies are not tracked.
 *
 * Nothing here allocates per call: results are written into a caller-supplied `GroundContact`.
 */
import { shapeBoundingRadius, shapeConvexPoints, shapeDef } from '../../model/shapeRegistry';
import type { Vec3 } from '../../core/math';
import type { ShapeSpec } from '../../model/types';

export type ContactKind = 'sphere' | 'cylinder' | 'capsule' | 'cone' | 'hull' | 'other';

/** What the contact search needs to know about a shape (derived once per body, see `contactSpecOf`). */
export interface ContactSpec {
  kind: ContactKind;
  /** Radius of a sphere / cylinder / capsule / cone base. */
  radius: number;
  /** Half the length of the axis part: a cylinder's or cone's half height, a capsule's half segment. */
  halfLength: number;
  /** Local-space convex points for a hull. */
  points: Vec3[] | null;
  /** Bounding radius: a body whose centre is higher above the floor than this cannot touch it. */
  reach: number;
}

export function contactSpecOf(shape: ShapeSpec): ContactSpec {
  const reach = shapeBoundingRadius(shape);
  const id = shapeDef(shape.type).id;
  const [sx, sy] = shape.size;
  if (id === 'sphere') return { kind: 'sphere', radius: sx / 2, halfLength: 0, points: null, reach };
  if (id === 'cylinder') return { kind: 'cylinder', radius: sx / 2, halfLength: sy / 2, points: null, reach };
  if (id === 'capsule')
    return { kind: 'capsule', radius: sx / 2, halfLength: Math.max(0, (sy - sx) / 2), points: null, reach };
  if (id === 'cone') return { kind: 'cone', radius: sx / 2, halfLength: sy / 2, points: null, reach };
  const pts = shapeConvexPoints(shape);
  if (pts?.length) return { kind: 'hull', radius: 0, halfLength: 0, points: pts, reach };
  return { kind: 'other', radius: reach, halfLength: 0, points: null, reach };
}

export interface GroundContact {
  /** The lowest point is within `tolerance` of the floor. */
  touching: boolean;
  /** Height of the lowest point above the floor, m (negative: penetrating). */
  clearance: number;
  /** The lowest point, world space. */
  x: number;
  y: number;
  z: number;
  /** Horizontal velocity of that point of the body, m/s. */
  slipX: number;
  slipZ: number;
  /** Its magnitude: how fast the surface slides over the ground. */
  slip: number;
  /** Horizontal speed of the centre of mass. */
  speed: number;
}

export function newGroundContact(): GroundContact {
  return { touching: false, clearance: Infinity, x: 0, y: 0, z: 0, slipX: 0, slipZ: 0, slip: 0, speed: 0 };
}

/**
 * Evaluate the ground contact of a body. `q` is the unit quaternion (x, y, z, w), `v` / `w` the linear and angular
 * velocity (world space). Writes into and returns `out`.
 */
export function groundContact(
  spec: ContactSpec,
  px: number,
  py: number,
  pz: number,
  qx: number,
  qy: number,
  qz: number,
  qw: number,
  vx: number,
  _vy: number,
  vz: number,
  wx: number,
  wy: number,
  wz: number,
  floorY: number,
  tolerance: number,
  out: GroundContact,
): GroundContact {
  out.speed = Math.hypot(vx, vz);
  // Too high to touch: skip the search.
  if (py - spec.reach > floorY + tolerance) {
    out.touching = false;
    out.clearance = py - spec.reach - floorY;
    out.slip = 0;
    out.slipX = out.slipZ = 0;
    return out;
  }
  let lx = px;
  let ly = py - spec.reach;
  let lz = pz;

  // World-space image of the local Y axis (the axis of cylinders, capsules and cones).
  const ax = 2 * (qx * qy - qw * qz);
  const ay = 1 - 2 * (qx * qx + qz * qz);
  const az = 2 * (qy * qz + qw * qx);

  switch (spec.kind) {
    case 'sphere':
      ly = py - spec.radius;
      break;
    case 'capsule': {
      const s = ay > 0 ? -1 : 1; // the end that is lower
      lx = px + s * spec.halfLength * ax;
      ly = py + s * spec.halfLength * ay - spec.radius;
      lz = pz + s * spec.halfLength * az;
      break;
    }
    case 'cylinder': {
      const s = ay > 0 ? -1 : 1;
      const cx = px + s * spec.halfLength * ax;
      const cy = py + s * spec.halfLength * ay;
      const cz = pz + s * spec.halfLength * az;
      // Rim point lowest in the cap's plane: direction (0, −1, 0) with its axis component removed.
      const da = -ay;
      const rx = -da * ax;
      const ry = -1 - da * ay;
      const rz = -da * az;
      const l = Math.hypot(rx, ry, rz);
      if (l > 1e-6) {
        lx = cx + (spec.radius * rx) / l;
        ly = cy + (spec.radius * ry) / l;
        lz = cz + (spec.radius * rz) / l;
      } else {
        lx = cx;
        ly = cy;
        lz = cz;
      }
      break;
    }
    case 'cone': {
      // Base centre at −h·axis, apex at +h·axis.
      const bx = px - spec.halfLength * ax;
      const by = py - spec.halfLength * ay;
      const bz = pz - spec.halfLength * az;
      const da = -ay;
      const rx = -da * ax;
      const ry = -1 - da * ay;
      const rz = -da * az;
      const l = Math.hypot(rx, ry, rz);
      let cx = bx;
      let cy = by;
      let cz = bz;
      if (l > 1e-6) {
        cx += (spec.radius * rx) / l;
        cy += (spec.radius * ry) / l;
        cz += (spec.radius * rz) / l;
      }
      const tipY = py + spec.halfLength * ay;
      if (tipY < cy) {
        lx = px + spec.halfLength * ax;
        ly = tipY;
        lz = pz + spec.halfLength * az;
      } else {
        lx = cx;
        ly = cy;
        lz = cz;
      }
      break;
    }
    case 'hull': {
      let best = Infinity;
      for (const pt of spec.points as Vec3[]) {
        // y component of q · pt
        const tx = 2 * (qy * pt[2] - qz * pt[1]);
        const ty = 2 * (qz * pt[0] - qx * pt[2]);
        const tz = 2 * (qx * pt[1] - qy * pt[0]);
        const wy2 = py + pt[1] + qw * ty + (qz * tx - qx * tz);
        if (wy2 < best) {
          best = wy2;
          lx = px + pt[0] + qw * tx + (qy * tz - qz * ty);
          lz = pz + pt[2] + qw * tz + (qx * ty - qy * tx);
          ly = wy2;
        }
      }
      break;
    }
    default:
      break;
  }

  out.x = lx;
  out.y = ly;
  out.z = lz;
  out.clearance = ly - floorY;
  out.touching = out.clearance <= tolerance;
  // v_c = v + ω × (p_c − x), horizontal part.
  const rx = lx - px;
  const ry = ly - py;
  const rz = lz - pz;
  out.slipX = vx + (wy * rz - wz * ry);
  out.slipZ = vz + (wx * ry - wy * rx);
  out.slip = out.touching ? Math.hypot(out.slipX, out.slipZ) : 0;
  return out;
}
