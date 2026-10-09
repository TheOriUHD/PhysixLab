/**
 * Shape geometry shared by the physics worker (collider construction, analytic volume)
 * and the renderer (visual meshes). Everything here is pure maths on ShapeSpec.
 */
import type { Vec3 } from '../core/math';
import type { ShapeSpec, ShapeType, SoftEntity } from './types';

export const SHAPE_LABELS: Record<ShapeType, string> = {
  box: 'Box',
  sphere: 'Sphere',
  cylinder: 'Cylinder',
  capsule: 'Capsule',
  cone: 'Cone',
  wedge: 'Ramp',
  prism: 'Prism',
  icosahedron: 'Icosahedron',
};

export const MIN_DIM = 0.02;

export function defaultSize(type: ShapeType): Vec3 {
  switch (type) {
    case 'box': return [1, 1, 1];
    case 'sphere': return [1, 1, 1];
    case 'cylinder': return [0.8, 1, 0.8];
    case 'capsule': return [0.6, 1.4, 0.6];
    case 'cone': return [0.9, 1.2, 0.9];
    case 'wedge': return [1, 0.6, 2];
    case 'prism': return [1, 0.8, 1];
    case 'icosahedron': return [1, 1, 1];
  }
}

/** Force a size vector into the shape's constraints (uniform axes etc.). */
export function normalizeSize(type: ShapeType, size: Vec3, prev?: Vec3): Vec3 {
  const s: Vec3 = [Math.max(MIN_DIM, size[0]), Math.max(MIN_DIM, size[1]), Math.max(MIN_DIM, size[2])];
  switch (type) {
    case 'sphere': {
      // Uniform: whichever axis changed most wins.
      let d = s[0];
      if (prev) {
        const dx = Math.abs(s[0] - prev[0]), dy = Math.abs(s[1] - prev[1]), dz = Math.abs(s[2] - prev[2]);
        d = dx >= dy && dx >= dz ? s[0] : dy >= dz ? s[1] : s[2];
      }
      return [d, d, d];
    }
    case 'cylinder':
    case 'capsule':
    case 'cone': {
      let d = s[0];
      if (prev) {
        const dx = Math.abs(s[0] - prev[0]), dz = Math.abs(s[2] - prev[2]);
        d = dx >= dz ? s[0] : s[2];
      }
      if (type === 'capsule') return [d, Math.max(s[1], d), d];
      return [d, s[1], d];
    }
    default:
      return s;
  }
}

/** Collider parameters for primitive shapes (half-extents etc.). */
export function primitiveParams(shape: ShapeSpec): { radius: number; halfHeight: number; half: Vec3 } {
  const [x, y, z] = shape.size;
  const radius = x / 2;
  switch (shape.type) {
    case 'capsule': return { radius, halfHeight: Math.max(0, (y - x) / 2), half: [x / 2, y / 2, z / 2] };
    default: return { radius, halfHeight: y / 2, half: [x / 2, y / 2, z / 2] };
  }
}

const PHI = (1 + Math.sqrt(5)) / 2;
const ICO_RAW: Vec3[] = [
  [-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0],
  [0, -1, PHI], [0, 1, PHI], [0, -1, -PHI], [0, 1, -PHI],
  [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1],
];

/** Vertices of convex-hull shapes in local space (centred at origin). Null for primitives. */
export function hullPoints(shape: ShapeSpec): Vec3[] | null {
  const [x, y, z] = shape.size;
  const hx = x / 2, hy = y / 2, hz = z / 2;
  switch (shape.type) {
    case 'wedge':
      // Right-triangle cross-section in the YZ plane: tall at +z, zero height at -z.
      return [
        [-hx, -hy, -hz], [hx, -hy, -hz],
        [-hx, -hy, hz], [hx, -hy, hz],
        [-hx, hy, hz], [hx, hy, hz],
      ];
    case 'prism': {
      const n = Math.max(3, Math.min(32, Math.round(shape.sides ?? 6)));
      const pts: Vec3[] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + Math.PI / 2;
        const px = Math.cos(a) * hx, pz = Math.sin(a) * hz;
        pts.push([px, -hy, pz], [px, hy, pz]);
      }
      return pts;
    }
    case 'icosahedron': {
      const len = Math.hypot(1, PHI);
      return ICO_RAW.map((p) => [(p[0] / len) * hx, (p[1] / len) * hy, (p[2] / len) * hz] as Vec3);
    }
    default:
      return null;
  }
}

/** Analytic volume in m³ (used for mass previews before a simulation is built). */
export function shapeVolume(shape: ShapeSpec): number {
  const [x, y, z] = shape.size;
  switch (shape.type) {
    case 'box': return x * y * z;
    case 'sphere': return (Math.PI / 6) * x * y * z;
    case 'cylinder': return Math.PI * (x / 2) * (z / 2) * y;
    case 'capsule': {
      const r = x / 2;
      const cyl = Math.max(0, y - x);
      return Math.PI * r * r * cyl + (4 / 3) * Math.PI * r * r * r;
    }
    case 'cone': return (Math.PI / 3) * (x / 2) * (z / 2) * y;
    case 'wedge': return 0.5 * x * y * z;
    case 'prism': {
      const n = Math.max(3, Math.min(32, Math.round(shape.sides ?? 6)));
      return 0.5 * n * (x / 2) * (z / 2) * Math.sin((Math.PI * 2) / n) * y;
    }
    case 'icosahedron': {
      // Regular icosahedron with circumradius 1 has volume (5/12)(3+√5) a³, a = 1/sin(2π/5)
      const a = 1 / Math.sin((2 * Math.PI) / 5);
      const v1 = (5 / 12) * (3 + Math.sqrt(5)) * a * a * a;
      return v1 * (x / 2) * (y / 2) * (z / 2);
    }
  }
}

/** Radius of a sphere that bounds the shape (picking, placement, spawn height). */
export function boundingRadius(shape: ShapeSpec): number {
  const [x, y, z] = shape.size;
  if (shape.type === 'sphere') return x / 2;
  return Math.hypot(x, y, z) / 2;
}

/** Half height of the shape along local Y (used to rest new objects on the ground). */
export function halfHeight(shape: ShapeSpec): number {
  return shape.size[1] / 2;
}

/**
 * Collision radius of one soft-body particle. It also sets how far the visible surface hovers
 * above whatever it rests on, so it is kept small relative to the lattice spacing.
 */
export function softParticleRadius(def: Pick<SoftEntity, 'type' | 'size' | 'resolution'>): number {
  const n = Math.max(2, def.resolution);
  switch (def.type) {
    case 'jelly': return Math.min(0.05, Math.max(0.012, (Math.min(...def.size) / (n - 1)) * 0.2));
    case 'balloon': return 0.02;
    case 'cloth': return Math.min(0.03, Math.max(0.01, (Math.min(def.size[0], def.size[2]) / (n - 1)) * 0.15));
    case 'cable': return 0.03;
  }
}
