/**
 * Rotate-by-angle (ED-14), pure: the new poses of a set of objects turned by an angle about an axis.
 *
 *   world space  one rigid turn about the world axis through the pivot (default: the centre of the selection), so a
 *                row of objects swings round together; each object's own orientation turns by the same rotation
 *   local space  every object turns about its own centre around its own local axis (a multi-selection does not swing)
 *
 * A single object is the same in both spaces except for which axis is meant (world X vs its own X).
 */
import { DEG, qfromAxisAngle, qmul, qnorm, qrot, vadd, vsub } from '../../core/math';
import type { Quat, Vec3 } from '../../core/math';

export interface PoseItem {
  id: string;
  position: Vec3;
  rotation: Quat;
}

export type TransformSpace = 'world' | 'local';

export const AXES: readonly Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

/** Mean position of the items. */
export function centreOf(items: readonly { position: Vec3 }[]): Vec3 {
  const c: Vec3 = [0, 0, 0];
  for (const it of items) {
    c[0] += it.position[0] / items.length;
    c[1] += it.position[1] / items.length;
    c[2] += it.position[2] / items.length;
  }
  return c;
}

/** The items after turning by `angleDeg` about `axis` (a unit axis index 0..2 or any vector). */
export function rotateBy(
  items: readonly PoseItem[],
  axis: 0 | 1 | 2 | Vec3,
  angleDeg: number,
  space: TransformSpace,
  pivot?: Vec3,
): PoseItem[] {
  const a: Vec3 = typeof axis === 'number' ? AXES[axis] : axis;
  const angle = angleDeg * DEG;
  if (space === 'local') {
    return items.map((it) => ({
      id: it.id,
      position: it.position,
      rotation: qnorm(qmul(it.rotation, qfromAxisAngle(a, angle))),
    }));
  }
  const q = qfromAxisAngle(a, angle);
  const c = pivot ?? centreOf(items);
  return items.map((it) => ({
    id: it.id,
    position: vadd(c, qrot(q, vsub(it.position, c))),
    rotation: qnorm(qmul(q, it.rotation)),
  }));
}

/** Translate items so that their centre moves from its current position to `target` on one axis. */
export function moveCentre(items: readonly PoseItem[], axis: 0 | 1 | 2, target: number): PoseItem[] {
  const d = target - centreOf(items)[axis];
  return items.map((it) => {
    const p: Vec3 = [it.position[0], it.position[1], it.position[2]];
    p[axis] += d;
    return { id: it.id, position: p, rotation: it.rotation };
  });
}
