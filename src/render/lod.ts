/**
 * VZ-31: level of detail for the round primitives. The geometry factories receive a `GeometryKit`; the LOD kits hand
 * them sphere / cylinder / cone / capsule constructors with fewer segments, so every shape built from those
 * primitives gets a cheaper mesh at a distance without any per-shape code. Shapes made of other geometry (convex hulls,
 * imported meshes) have a single level.
 */
import { CapsuleGeometry, ConeGeometry, CylinderGeometry, SphereGeometry } from 'three';
import type { GeometryKit } from '../model/shapeRegistry';
import { GEOMETRY_KIT } from './geometryKit';

export const LOD_LEVELS = 3;

/** On-screen radius (px) above which level 0 is used, and above which level 1 is; below that level 2. */
export const LOD_PX = [36, 12] as const;
const HYSTERESIS = 0.2;

/** Level for an on-screen radius, staying on the current level inside a ±20 % band around each threshold. */
export function lodForScreenRadius(px: number, current: number): number {
  let level = px >= LOD_PX[0] ? 0 : px >= LOD_PX[1] ? 1 : 2;
  if (level !== current) {
    // Only switch once the radius is clearly past the threshold that separates the two levels.
    const edge = level < current ? LOD_PX[Math.min(level, 1)] : LOD_PX[Math.min(current, 1)];
    if (level < current && px < edge * (1 + HYSTERESIS)) level = current;
    else if (level > current && px > edge * (1 - HYSTERESIS)) level = current;
  }
  return level;
}

/** Segment count at `level`: halved per level, never below `min`. */
export function reduce(n: number | undefined, level: number, fallback: number, min: number): number {
  return Math.max(min, Math.round((n ?? fallback) / 2 ** level));
}

const kits: GeometryKit[] = [GEOMETRY_KIT];

function make(level: number): GeometryKit {
  type P<T extends abstract new (...a: never[]) => unknown> = ConstructorParameters<T>;
  class Sphere extends SphereGeometry {
    constructor(...[r, w, h, ...rest]: P<typeof SphereGeometry>) {
      super(r, reduce(w, level, 32, 8), reduce(h, level, 16, 5), ...rest);
    }
  }
  class Cylinder extends CylinderGeometry {
    constructor(...[rt, rb, h, radial, ...rest]: P<typeof CylinderGeometry>) {
      super(rt, rb, h, reduce(radial, level, 32, 8), ...rest);
    }
  }
  class Cone extends ConeGeometry {
    constructor(...[r, h, radial, ...rest]: P<typeof ConeGeometry>) {
      super(r, h, reduce(radial, level, 32, 8), ...rest);
    }
  }
  class Capsule extends CapsuleGeometry {
    constructor(...[r, l, cap, radial, ...rest]: P<typeof CapsuleGeometry>) {
      super(r, l, reduce(cap, level, 8, 2), reduce(radial, level, 16, 8), ...rest);
    }
  }
  return {
    ...GEOMETRY_KIT,
    SphereGeometry: Sphere,
    CylinderGeometry: Cylinder,
    ConeGeometry: Cone,
    CapsuleGeometry: Capsule,
  };
}

/** The geometry kit for an LOD level (0 = full detail). */
export function lodKit(level: number): GeometryKit {
  return (kits[level] ??= make(level));
}
