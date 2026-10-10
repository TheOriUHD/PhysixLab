/**
 * Time-series storage for the chart widgets (DOM-free, allocation-free on the sampling path).
 *
 * A `MultiSeries` is a ring buffer of rows: one shared time stamp and one value per channel (trace). All channels
 * of a chart are sampled at the same instants, so cursor read-outs, CSV export, XY plots and spectra all index the
 * same rows. Rows are decimated at the source: `accept(t)` refuses a sample closer than `minDt` to the previous one,
 * and the capacity (`recordLength × sampleHz`) bounds the memory; once full, the oldest row is overwritten.
 */
export class MultiSeries {
  private t: Float64Array;
  private ch: Float64Array[] = [];
  private head = 0; // physical index of the oldest row
  private n = 0;
  private lastT = -Infinity;
  cap: number;
  /** Minimum simulated time between two rows (decimation), seconds. */
  minDt: number;

  constructor(cap: number, minDt = 1 / 60) {
    this.cap = Math.max(2, Math.floor(cap));
    this.minDt = minDt;
    this.t = new Float64Array(this.cap);
  }

  get length(): number {
    return this.n;
  }
  get channels(): number {
    return this.ch.length;
  }
  get lastTime(): number {
    return this.n ? this.t[(this.head + this.n - 1) % this.cap] : -Infinity;
  }
  get firstTime(): number {
    return this.n ? this.t[this.head] : Infinity;
  }

  /** Add a channel; earlier rows read as NaN. Returns its index. */
  addChannel(): number {
    const a = new Float64Array(this.cap);
    a.fill(NaN);
    this.ch.push(a);
    return this.ch.length - 1;
  }
  /** Remove a channel (higher indices shift down). */
  removeChannel(i: number): void {
    if (i >= 0 && i < this.ch.length) this.ch.splice(i, 1);
  }

  /** Would a row at time `t` be recorded? A time that went backwards counts (the caller clears first). */
  accept(t: number): boolean {
    return t < this.lastT || t - this.lastT >= this.minDt - 1e-9;
  }

  /** Start a new row at time `t` (NaN in every channel); returns the logical row index. Allocation-free. */
  beginRow(t: number): number {
    let slot: number;
    if (this.n < this.cap) slot = (this.head + this.n++) % this.cap;
    else {
      slot = this.head;
      this.head = (this.head + 1) % this.cap;
    }
    this.t[slot] = t;
    for (let c = 0; c < this.ch.length; c++) this.ch[c][slot] = NaN;
    this.lastT = t;
    return this.n - 1;
  }
  /** Write the value of channel `c` into logical row `i`. */
  set(c: number, i: number, v: number): void {
    this.ch[c][(this.head + i) % this.cap] = v;
  }

  timeAt(i: number): number {
    return this.t[(this.head + i) % this.cap];
  }
  valueAt(c: number, i: number): number {
    return this.ch[c][(this.head + i) % this.cap];
  }

  /** First logical row whose time is >= `t` (`length` when none). */
  lowerBound(t: number): number {
    let lo = 0;
    let hi = this.n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.timeAt(mid) < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  /** Row nearest to time `t`, or -1 when empty. */
  nearest(t: number): number {
    if (!this.n) return -1;
    const i = this.lowerBound(t);
    if (i === 0) return 0;
    if (i >= this.n) return this.n - 1;
    return t - this.timeAt(i - 1) <= this.timeAt(i) - t ? i - 1 : i;
  }

  clear(): void {
    this.head = 0;
    this.n = 0;
    this.lastT = -Infinity;
  }

  /** Change the capacity, keeping the newest rows. */
  resize(cap: number): void {
    cap = Math.max(2, Math.floor(cap));
    if (cap === this.cap) return;
    const keep = Math.min(this.n, cap);
    const first = this.n - keep;
    const nt = new Float64Array(cap);
    const nch = this.ch.map(() => new Float64Array(cap).fill(NaN));
    for (let i = 0; i < keep; i++) {
      nt[i] = this.timeAt(first + i);
      for (let c = 0; c < nch.length; c++) nch[c][i] = this.valueAt(c, first + i);
    }
    this.t = nt;
    this.ch = nch;
    this.cap = cap;
    this.head = 0;
    this.n = keep;
  }

  /**
   * Linear resample of channel `c` onto `out.length` uniform points spanning [t0, t1]. A gap (NaN) is filled by
   * the neighbouring valid sample. Returns false if there are fewer than 2 rows or nothing valid in range.
   */
  resampleUniform(c: number, t0: number, t1: number, out: Float64Array): boolean {
    const m = out.length;
    if (m < 2 || this.n < 2 || !(t1 > t0)) return false;
    let i = Math.max(1, this.lowerBound(t0));
    let any = false;
    for (let k = 0; k < m; k++) {
      const tk = t0 + ((t1 - t0) * k) / (m - 1);
      while (i < this.n - 1 && this.timeAt(i) < tk) i++;
      const ta = this.timeAt(i - 1);
      const tb = this.timeAt(i);
      const va = this.valueAt(c, i - 1);
      const vb = this.valueAt(c, i);
      let v: number;
      if (Number.isNaN(va) && Number.isNaN(vb)) v = NaN;
      else if (Number.isNaN(va)) v = vb;
      else if (Number.isNaN(vb)) v = va;
      else {
        const f = tb > ta ? (tk - ta) / (tb - ta) : 0;
        v = va + (vb - va) * Math.min(1, Math.max(0, f));
      }
      out[k] = v;
      if (!Number.isNaN(v)) any = true;
    }
    return any;
  }
}
