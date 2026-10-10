/**
 * Skid marks, the data side: a ring buffer of ground-strip segments, no three.js involved.
 *
 * A *source* (a slipping wheel, a sliding body) calls `extend(key, …)` every frame with where its contact patch is.
 * Once it has moved `MIN_STEP` from the last anchor the buffer appends one quad — four vertices, two triangles —
 * from the previous edge to a new edge across the direction of travel, so consecutive segments share their edge and
 * the strip is continuous. A strip restarts after a sharp reversal or a jump, and ends (`endStale`) when its source
 * stops calling. The buffer holds `capacity` segments; when full the oldest are overwritten, so memory is bounded and
 * a long drift never grows the scene. Each vertex carries (birth time, side −1 … 1, opacity, tone); the shader fades
 * a mark by age and softens its edges, so nothing is rewritten while marks age.
 */

export const MIN_STEP = 0.1;
/** A source that jumps farther than this between frames starts a new strip instead of drawing a long bridge. */
export const MAX_GAP = 2.5;

interface Strip {
  started: boolean;
  /** Anchor: where the last segment ended. */
  x: number;
  y: number;
  z: number;
  dirX: number;
  dirZ: number;
  /** Edge of the last segment, left then right. */
  hasEdge: boolean;
  lx: number;
  lz: number;
  rx: number;
  rz: number;
  alpha: number;
  segments: number;
  stamp: number;
}

export class SkidBuffer {
  /** Segment slots (a fixed allocation). */
  readonly capacity: number;
  /** 4 vertices per segment, xyz. */
  readonly pos: Float32Array;
  /** 4 vertices per segment: birth time, side (−1 left … 1 right), opacity, tone. */
  readonly mark: Float32Array;
  /** Live segments. */
  count = 0;
  /** The soft cap (≤ capacity): the quality tier. */
  private cap: number;
  private head = 0;
  /** Slots written since the last `takeDirty`: [min, max] or empty. */
  private dirtyMin = Infinity;
  private dirtyMax = -1;
  private readonly strips = new Map<number, Strip>();
  /** Total segments ever added (for tests / stats). */
  added = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.cap = capacity;
    this.pos = new Float32Array(capacity * 12);
    this.mark = new Float32Array(capacity * 16);
  }

  get limit(): number {
    return this.cap;
  }

  /** Change the soft cap. Shrinking below the number of segments clears them (the ring would be inconsistent). */
  setLimit(n: number): void {
    const next = Math.max(8, Math.min(this.capacity, Math.floor(n)));
    if (next < this.count) this.clear();
    this.cap = next;
    if (this.head >= next) this.head = 0;
  }

  /** Drop every mark and every strip in progress. */
  clear(): void {
    this.count = 0;
    this.head = 0;
    this.strips.clear();
    this.dirtyMin = 0;
    this.dirtyMax = this.capacity - 1;
  }

  /** The slot range written since the last call as [min, max] (inclusive), or null; resets the range. */
  takeDirty(): [number, number] | null {
    if (this.dirtyMax < 0) return null;
    const r: [number, number] = [this.dirtyMin, this.dirtyMax];
    this.dirtyMin = Infinity;
    this.dirtyMax = -1;
    return r;
  }

  /** Number of strips currently being drawn. */
  get activeStrips(): number {
    return this.strips.size;
  }

  /**
   * A source touches the ground at (x, y, z) this frame. `width` is the tread width, `alpha` the mark opacity this
   * frame and `tone` its shade (0 black … 1 pale); `time` the effects clock; `stamp` identifies the frame so
   * `endStale(stamp)` can end the strips whose source did not call. Returns true when a segment was added.
   */
  extend(
    key: number,
    x: number,
    y: number,
    z: number,
    width: number,
    alpha: number,
    tone: number,
    time: number,
    stamp: number,
  ): boolean {
    let s = this.strips.get(key);
    if (!s) {
      s = {
        started: false,
        x: 0,
        y: 0,
        z: 0,
        dirX: 0,
        dirZ: 0,
        hasEdge: false,
        lx: 0,
        lz: 0,
        rx: 0,
        rz: 0,
        alpha: 0,
        segments: 0,
        stamp,
      };
      this.strips.set(key, s);
    }
    s.stamp = stamp;
    if (!s.started) {
      this.restart(s, x, y, z);
      return false;
    }
    const dx = x - s.x;
    const dz = z - s.z;
    const dist = Math.hypot(dx, dz);
    if (dist < MIN_STEP) return false;
    if (dist > MAX_GAP) {
      this.restart(s, x, y, z);
      return false;
    }
    const dirX = dx / dist;
    const dirZ = dz / dist;
    if (s.segments > 0 && dirX * s.dirX + dirZ * s.dirZ < -0.2) {
      this.restart(s, x, y, z);
      return false;
    }
    const half = Math.max(0.01, width) / 2;
    const px = -dirZ;
    const pz = dirX;
    const sy = s.y;
    // Start edge: the previous segment's end edge, or, for the first segment, across the direction of travel.
    const slx = s.hasEdge ? s.lx : s.x + px * half;
    const slz = s.hasEdge ? s.lz : s.z + pz * half;
    const srx = s.hasEdge ? s.rx : s.x - px * half;
    const srz = s.hasEdge ? s.rz : s.z - pz * half;
    const elx = x + px * half;
    const elz = z + pz * half;
    const erx = x - px * half;
    const erz = z - pz * half;
    // Fade in over the first few segments of a strip.
    const a1 = alpha * Math.min(1, (s.segments + 1) / 4);
    const a0 = s.segments === 0 ? 0 : s.alpha;

    const slot = this.head;
    this.head = (this.head + 1) % this.cap;
    if (this.count < this.cap) this.count++;
    this.added++;
    this.dirtyMin = Math.min(this.dirtyMin, slot);
    this.dirtyMax = Math.max(this.dirtyMax, slot);
    const p = slot * 12;
    const m = slot * 16;
    const P = this.pos;
    const M = this.mark;
    P[p] = slx;
    P[p + 1] = sy;
    P[p + 2] = slz;
    P[p + 3] = srx;
    P[p + 4] = sy;
    P[p + 5] = srz;
    P[p + 6] = elx;
    P[p + 7] = y;
    P[p + 8] = elz;
    P[p + 9] = erx;
    P[p + 10] = y;
    P[p + 11] = erz;
    // left start, right start, left end, right end
    M[m] = time;
    M[m + 1] = -1;
    M[m + 2] = a0;
    M[m + 3] = tone;
    M[m + 4] = time;
    M[m + 5] = 1;
    M[m + 6] = a0;
    M[m + 7] = tone;
    M[m + 8] = time;
    M[m + 9] = -1;
    M[m + 10] = a1;
    M[m + 11] = tone;
    M[m + 12] = time;
    M[m + 13] = 1;
    M[m + 14] = a1;
    M[m + 15] = tone;

    s.x = x;
    s.y = y;
    s.z = z;
    s.dirX = dirX;
    s.dirZ = dirZ;
    s.hasEdge = true;
    s.lx = elx;
    s.lz = elz;
    s.rx = erx;
    s.rz = erz;
    s.alpha = a1;
    s.segments++;
    return true;
  }

  private restart(s: Strip, x: number, y: number, z: number): void {
    s.started = true;
    s.x = x;
    s.y = y;
    s.z = z;
    s.hasEdge = false;
    s.segments = 0;
    s.alpha = 0;
  }

  /** End every strip whose source did not call `extend` with this `stamp`. */
  endStale(stamp: number): void {
    for (const [k, s] of this.strips) if (s.stamp !== stamp) this.strips.delete(k);
  }

  /** The vertices of a segment slot, for tests: left start, right start, left end, right end as [x, y, z]. */
  vertices(slot: number): [number, number, number][] {
    const out: [number, number, number][] = [];
    for (let v = 0; v < 4; v++)
      out.push([this.pos[slot * 12 + v * 3], this.pos[slot * 12 + v * 3 + 1], this.pos[slot * 12 + v * 3 + 2]]);
    return out;
  }
}
