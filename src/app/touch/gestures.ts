/**
 * Pure touch-gesture logic (no DOM): what a set of fingers is doing, and the long-press / two-finger classifiers.
 *
 * Camera mapping (see `touchController.ts` for the wiring):
 *   1 finger   the active tool (select, marquee, drag-move, gizmo …); a long press opens the context menu
 *   2 fingers  pinch = zoom, drag = orbit (or pan, a setting); with "move with two fingers" on, a drag moves the
 *              selection and a pinch still zooms (decided by the first few pixels of motion)
 *   3 fingers  drag = pan
 */

export interface TouchPoint {
  id: number;
  x: number;
  y: number;
}

/** Fingers currently down, with the centroid / spread of the group. */
export class FingerSet {
  private pts = new Map<number, TouchPoint>();
  private scratch = { x: 0, y: 0 };

  get count(): number {
    return this.pts.size;
  }

  has(id: number): boolean {
    return this.pts.has(id);
  }

  down(id: number, x: number, y: number): void {
    this.pts.set(id, { id, x, y });
  }

  move(id: number, x: number, y: number): boolean {
    const p = this.pts.get(id);
    if (!p) return false;
    p.x = x;
    p.y = y;
    return true;
  }

  up(id: number): void {
    this.pts.delete(id);
  }

  clear(): void {
    this.pts.clear();
  }

  /** The fingers in the order they touched down. */
  points(): readonly TouchPoint[] {
    return [...this.pts.values()];
  }

  /** Mean position of all fingers (0, 0 when there are none). Pass `out` to avoid an allocation. */
  centroid(out: { x: number; y: number } = { x: 0, y: 0 }): { x: number; y: number } {
    let sx = 0,
      sy = 0;
    for (const p of this.pts.values()) {
      sx += p.x;
      sy += p.y;
    }
    const n = this.pts.size || 1;
    out.x = sx / n;
    out.y = sy / n;
    return out;
  }

  /** Mean distance of the fingers from their centroid, times two (= the finger distance for two fingers). */
  spread(): number {
    if (this.pts.size < 2) return 0;
    const c = this.centroid(this.scratch);
    let s = 0;
    for (const p of this.pts.values()) s += Math.hypot(p.x - c.x, p.y - c.y);
    return (2 * s) / this.pts.size;
  }
}

// -- NAV: the twist of two fingers --
/** Angle (radians) of the line from the first finger to the second; null unless exactly two fingers are down. */
export function twoFingerAngle(f: FingerSet): number | null {
  const pts = f.points();
  return pts.length === 2 ? Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x) : null;
}

/** Signed difference `to − from` wrapped into (−π, π]. */
export function angleStep(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

export type TwoFingerKind = 'undecided' | 'drag' | 'pinch';

/** Pixels of motion before a two-finger gesture commits to being a drag or a pinch. */
export const TWO_FINGER_DECIDE_PX = 10;

/**
 * Decide between dragging and pinching from the travel of the centroid and the change of the finger distance since
 * the gesture began. Whichever grows past the threshold first, by the larger amount, wins.
 */
export function classifyTwoFinger(centroidTravel: number, spreadChange: number): TwoFingerKind {
  const drag = Math.abs(centroidTravel);
  const pinch = Math.abs(spreadChange);
  if (Math.max(drag, pinch) < TWO_FINGER_DECIDE_PX) return 'undecided';
  return pinch > drag ? 'pinch' : 'drag';
}

/** Long press: the finger stays within `tolerance` px of where it landed for `delay` ms, alone. */
export class LongPress {
  private active = false;
  private x0 = 0;
  private y0 = 0;
  private id = -1;
  private t0 = 0;

  constructor(
    public delay = 500,
    readonly tolerance = 10,
  ) {}

  get pointerId(): number {
    return this.id;
  }

  begin(id: number, x: number, y: number, now: number): void {
    this.active = true;
    this.id = id;
    this.x0 = x;
    this.y0 = y;
    this.t0 = now;
  }

  /** Feed a move; returns false (and disarms) once the finger left the tolerance circle. */
  move(id: number, x: number, y: number): boolean {
    if (!this.active || id !== this.id) return this.active;
    if (Math.hypot(x - this.x0, y - this.y0) > this.tolerance) this.active = false;
    return this.active;
  }

  cancel(): void {
    this.active = false;
  }

  /** Milliseconds still to wait before the press counts (0 = due now), or -1 when no press is armed. */
  remaining(now: number): number {
    return this.active ? Math.max(0, this.delay - (now - this.t0)) : -1;
  }

  /** Has the press been held long enough (and not cancelled)? Consumes the press when it has. */
  fire(now: number): boolean {
    if (!this.active || now - this.t0 < this.delay) return false;
    this.active = false;
    return true;
  }

  get armed(): boolean {
    return this.active;
  }
}

/** World metres per screen pixel of a perspective view at `distance` from the camera. */
export function perspectivePixel(distance: number, fovDeg: number, viewportHeight: number): number {
  return (2 * distance * Math.tan((fovDeg * Math.PI) / 360)) / Math.max(1, viewportHeight);
}

/** World metres per screen pixel of an orthographic view (`orthoSize` = visible height at zoom 1). */
export function orthoPixel(orthoSize: number, zoom: number, viewportHeight: number): number {
  return orthoSize / Math.max(1e-6, zoom) / Math.max(1, viewportHeight);
}

/**
 * World-space shift of camera and target for a screen pan of (dx, dy) pixels at `perPixel` metres per pixel: the scene
 * follows the fingers. `right` / `up` are the camera's world axes.
 */
export function panShift(
  dx: number,
  dy: number,
  perPixel: number,
  right: readonly [number, number, number],
  up: readonly [number, number, number],
  out: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  const sx = -dx * perPixel;
  const sy = dy * perPixel;
  out[0] = right[0] * sx + up[0] * sy;
  out[1] = right[1] * sx + up[1] * sy;
  out[2] = right[2] * sx + up[2] * sy;
  return out;
}

/** New orthographic zoom after a pinch that scaled the finger distance by `scale` (>1 = fingers apart = zoom in). */
export function pinchZoom(zoom: number, scale: number, min: number, max: number): number {
  if (!(scale > 0) || !Number.isFinite(scale)) return zoom;
  return Math.min(max, Math.max(min, zoom * scale));
}

/** New camera distance after a pinch that scaled the finger distance by `scale` (>1 = fingers apart = zoom in). */
export function pinchDistance(distance: number, scale: number, min: number, max: number): number {
  if (!(scale > 0) || !Number.isFinite(scale)) return distance;
  return Math.min(max, Math.max(min, distance / scale));
}

/** Snap a ground-plane move so the primary object lands on the grid (like the mouse drag does). */
export function snapMove(
  base: readonly [number, number, number],
  delta: readonly [number, number, number],
  grid: number,
): [number, number, number] {
  if (!(grid > 0)) return [delta[0], delta[1], delta[2]];
  const snap = (v: number) => Math.round(v / grid) * grid;
  return [snap(base[0] + delta[0]) - base[0], delta[1], snap(base[2] + delta[2]) - base[2]];
}
