// -- DT-2: turntable camera path (pure) --
/** The camera path of a turntable recording: a full revolution about the vertical axis through a target point. */

export type V3 = [number, number, number];

/** Camera orbit angle of output frame `index` of `count`: frame 0 is the start, frame `count` would equal it (seamless loop). */
export function turntableAngle(index: number, count: number, direction: 1 | -1 = 1): number {
  return (direction * 2 * Math.PI * index) / Math.max(1, count);
}

/** Rotate the offset (camera − target) about the world Y axis by `angle`. */
export function rotateOffsetY(offset: V3, angle: number): V3 {
  const c = Math.cos(angle),
    s = Math.sin(angle);
  return [offset[0] * c + offset[2] * s, offset[1], -offset[0] * s + offset[2] * c];
}

export interface TurntablePose {
  position: V3;
  target: V3;
}

/** Camera pose at `angle` for an orbit about `target` that starts from `offset` (camera position − target). */
export function turntablePose(target: V3, offset: V3, angle: number): TurntablePose {
  const o = rotateOffsetY(offset, angle);
  return { position: [target[0] + o[0], target[1] + o[1], target[2] + o[2]], target: [...target] };
}

/**
 * The offset a turntable starts from: the current viewing direction (so the first frame matches what the user
 * sees), with the distance chosen so a sphere of `radius` fits the vertical field of view, and an elevation of at
 * least ~8° so the camera never dips under the ground.
 */
export function turntableOffset(current: V3, radius: number, fovDeg: number): V3 {
  const len = Math.hypot(...current) || 1;
  let dir: V3 = [current[0] / len, current[1] / len, current[2] / len];
  const minY = Math.sin((8 * Math.PI) / 180);
  if (dir[1] < minY) {
    const flat = Math.hypot(dir[0], dir[2]);
    const k = flat > 1e-6 ? Math.sqrt(1 - minY * minY) / flat : 0;
    dir = flat > 1e-6 ? [dir[0] * k, minY, dir[2] * k] : [0, minY, Math.sqrt(1 - minY * minY)];
  }
  const dist = Math.max(2.2, (radius / Math.tan((fovDeg * Math.PI) / 360)) * 1.35);
  return [dir[0] * dist, dir[1] * dist, dir[2] * dist];
}
