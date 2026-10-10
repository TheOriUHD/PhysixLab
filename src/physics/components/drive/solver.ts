/**
 * The velocity-level solver of the drive network (`network.ts`).
 *
 * A drive train is a small system of one-dimensional degrees of freedom ("shafts": a speed ω in rad/s, or a speed in
 * m/s for a linear actuator) coupled by linear constraint rows
 *
 *     C(ω') = Σ jᵢ·ω'ᵢ − rhs          with an impulse λ ∈ [lo, hi]
 *
 * and the usual complementarity conditions of a mixed LCP: where λ lies strictly between its bounds the row holds
 * exactly (C = 0); at `lo` the row would like to push further down, so C ≥ 0 is left over; at `hi`, C ≤ 0.
 *
 *  - gears and locked differentials are unbounded equalities (C = ω_in − r·ω_out = 0),
 *  - a clutch, a brake or a motor that follows a target speed is a bounded equality (|λ| ≤ torque·dt): exact while
 *    the torque suffices, saturated (slipping) when it does not,
 *  - a speed limit or a travel stop is a one-sided row (λ bounded on one side only).
 *
 * Every shaft i has a free speed v0ᵢ (its speed after the explicit part of its sources) and an inverse effective
 * inertia invᵢ, so the new speeds are ω' = v0 + inv·Jᵀλ. This is exactly the system a sequential-impulse solver
 * iterates on, solved here *directly* (an active-set method on the dense matrix A = J·inv·Jᵀ, per connected
 * cluster of rows): a stiff chain — a light engine flywheel locked through a 10:1 gear to a heavy wheel — converges
 * in one solve instead of hundreds of Gauss-Seidel sweeps, and so never goes unstable however the inertias compare.
 *
 * Pure numbers, no allocation after warm-up (typed arrays that only grow), deterministic (rows are visited in the
 * order they were added).
 */

/** Largest number of shafts one row may touch (a differential touches three). */
export const MAX_ENTRIES = 4;

const FREE = 0;
const AT_LO = 1;
const AT_HI = 2;
/** A row that can do nothing (its bounds coincide): its impulse is the bound and it is never released. */
const DEAD = 3;

export class DriveSolver {
  // shafts
  nodeCount = 0;
  inv: Float64Array = new Float64Array(16);
  v0: Float64Array = new Float64Array(16);
  /** Result: the speed of every shaft after the solve. */
  v: Float64Array = new Float64Array(16);

  // rows
  rowCount = 0;
  private rowN: Int32Array = new Int32Array(16);
  private rowNode: Int32Array = new Int32Array(16 * MAX_ENTRIES);
  private rowJ: Float64Array = new Float64Array(16 * MAX_ENTRIES);
  private rhs: Float64Array = new Float64Array(16);
  lo: Float64Array = new Float64Array(16);
  hi: Float64Array = new Float64Array(16);
  /** Result: the impulse each row applied (N·m·s for a rotational row). */
  lambda: Float64Array = new Float64Array(16);

  // scratch
  private parent: Int32Array = new Int32Array(16);
  private rank: Int32Array = new Int32Array(16);
  private cnt: Int32Array = new Int32Array(17);
  private pos: Int32Array = new Int32Array(17);
  private order: Int32Array = new Int32Array(16);
  private cluster: Int32Array = new Int32Array(16);
  private state: Uint8Array = new Uint8Array(16);
  private c0: Float64Array = new Float64Array(16);
  private a: Float64Array = new Float64Array(16 * 16);
  private m: Float64Array = new Float64Array(16 * 16);
  private x: Float64Array = new Float64Array(16);
  private b: Float64Array = new Float64Array(16);
  private free: Int32Array = new Int32Array(16);

  clear(): void {
    this.nodeCount = 0;
    this.rowCount = 0;
  }

  /** Add a shaft with inverse inertia `inv` (0 = immovable) and free speed `v0`; returns its index. */
  addNode(inv: number, v0: number): number {
    const i = this.nodeCount++;
    if (i >= this.inv.length) {
      this.inv = grow(this.inv, i + 1);
      this.v0 = grow(this.v0, i + 1);
      this.v = grow(this.v, i + 1);
      this.parent = growI(this.parent, i + 1);
      this.rank = growI(this.rank, i + 1);
    }
    this.inv[i] = inv;
    this.v0[i] = v0;
    this.v[i] = v0;
    return i;
  }

  /** Start a row `Σ jᵢ·ω'ᵢ = rhs` with impulse bounds [lo, hi]; returns its index. */
  addRow(rhs: number, lo: number, hi: number): number {
    const k = this.rowCount++;
    if (k >= this.rhs.length) {
      const n = k + 1;
      this.rowN = growI(this.rowN, n);
      this.rowNode = growI(this.rowNode, n * MAX_ENTRIES);
      this.rowJ = grow(this.rowJ, n * MAX_ENTRIES);
      this.rhs = grow(this.rhs, n);
      this.lo = grow(this.lo, n);
      this.hi = grow(this.hi, n);
      this.lambda = grow(this.lambda, n);
      this.order = growI(this.order, n);
      this.cnt = growI(this.cnt, n + 1);
      this.pos = growI(this.pos, n + 1);
      this.cluster = growI(this.cluster, n);
      this.state = growU8(this.state, n);
      this.c0 = grow(this.c0, n);
      this.x = grow(this.x, n);
      this.b = grow(this.b, n);
      this.free = growI(this.free, n);
    }
    this.rowN[k] = 0;
    this.rhs[k] = rhs;
    this.lo[k] = lo;
    this.hi[k] = hi;
    this.lambda[k] = 0;
    return k;
  }

  /** Add the term `j·ω'(node)` to row `k` (at most `MAX_ENTRIES` terms). */
  addEntry(k: number, node: number, j: number): void {
    const n = this.rowN[k];
    if (n >= MAX_ENTRIES) throw new Error('drive row has too many terms');
    this.rowNode[k * MAX_ENTRIES + n] = node;
    this.rowJ[k * MAX_ENTRIES + n] = j;
    this.rowN[k] = n + 1;
  }

  /** Solve everything that was added; results are in `v` and `lambda`. */
  solve(): void {
    const nr = this.rowCount;
    if (nr === 0) return;
    this.buildClusters();
    // Rows of one cluster are solved together; clusters in order of their first row.
    let start = 0;
    while (start < nr) {
      const root = this.cluster[this.order[start]];
      let end = start + 1;
      while (end < nr && this.cluster[this.order[end]] === root) end++;
      this.solveCluster(start, end);
      start = end;
    }
    // new speeds: ω' = v0 + inv·Jᵀλ
    for (let i = 0; i < this.nodeCount; i++) this.v[i] = this.v0[i];
    for (let k = 0; k < nr; k++) {
      const l = this.lambda[k];
      if (l === 0) continue;
      for (let e = 0; e < this.rowN[k]; e++) {
        const node = this.rowNode[k * MAX_ENTRIES + e];
        this.v[node] += this.inv[node] * this.rowJ[k * MAX_ENTRIES + e] * l;
      }
    }
  }

  /** Residual `Σ jᵢ·ω'ᵢ − rhs` of a row after the solve (≈ 0 unless the row is saturated). */
  residual(k: number): number {
    let c = -this.rhs[k];
    for (let e = 0; e < this.rowN[k]; e++)
      c += this.rowJ[k * MAX_ENTRIES + e] * this.v[this.rowNode[k * MAX_ENTRIES + e]];
    return c;
  }

  // ---- clusters ------------------------------------------------------------------------------------

  private find(i: number): number {
    const p = this.parent;
    while (p[i] !== i) {
      p[i] = p[p[i]];
      i = p[i];
    }
    return i;
  }

  /** Group the rows into clusters (rows that share a shaft, transitively), keeping the order of addition. */
  private buildClusters(): void {
    const nr = this.rowCount;
    for (let i = 0; i < this.nodeCount; i++) {
      this.parent[i] = i;
      this.rank[i] = -1;
    }
    for (let k = 0; k < nr; k++) {
      const n = this.rowN[k];
      if (n === 0) continue;
      const r0 = this.find(this.rowNode[k * MAX_ENTRIES]);
      for (let e = 1; e < n; e++) {
        const r = this.find(this.rowNode[k * MAX_ENTRIES + e]);
        if (r !== r0) this.parent[r] = r0;
      }
    }
    // clusters are numbered by their first row; a row without terms is a cluster of its own
    let nc = 0;
    for (let k = 0; k < nr; k++) {
      if (this.rowN[k] === 0) {
        this.cluster[k] = nc++;
        continue;
      }
      const root = this.find(this.rowNode[k * MAX_ENTRIES]);
      if (this.rank[root] < 0) this.rank[root] = nc++;
      this.cluster[k] = this.rank[root];
    }
    // stable counting sort of the rows by cluster
    for (let c = 0; c <= nc; c++) this.cnt[c] = 0;
    for (let k = 0; k < nr; k++) this.cnt[this.cluster[k] + 1]++;
    for (let c = 0; c < nc; c++) this.cnt[c + 1] += this.cnt[c];
    for (let c = 0; c <= nc; c++) this.pos[c] = this.cnt[c];
    for (let k = 0; k < nr; k++) this.order[this.pos[this.cluster[k]]++] = k;
  }

  // ---- one cluster ---------------------------------------------------------------------------------

  /** `A[k][l] = Σ jₖᵢ·jₗᵢ·invᵢ` over the shafts both rows touch. */
  private coupling(k: number, l: number): number {
    let sum = 0;
    for (let e = 0; e < this.rowN[k]; e++) {
      const nk = this.rowNode[k * MAX_ENTRIES + e];
      for (let f = 0; f < this.rowN[l]; f++) {
        if (this.rowNode[l * MAX_ENTRIES + f] === nk)
          sum += this.rowJ[k * MAX_ENTRIES + e] * this.rowJ[l * MAX_ENTRIES + f] * this.inv[nk];
      }
    }
    return sum;
  }

  private solveCluster(start: number, end: number): void {
    const m = end - start;
    // free-velocity residual of each row: c0 = J·v0 − rhs
    for (let i = 0; i < m; i++) {
      const k = this.order[start + i];
      let c = -this.rhs[k];
      for (let e = 0; e < this.rowN[k]; e++)
        c += this.rowJ[k * MAX_ENTRIES + e] * this.v0[this.rowNode[k * MAX_ENTRIES + e]];
      this.c0[i] = c;
    }
    if (m === 1) {
      const k = this.order[start];
      const a = this.coupling(k, k);
      const lam = a > 1e-300 ? -this.c0[0] / a : 0;
      this.lambda[k] = Math.min(Math.max(lam, this.lo[k]), this.hi[k]);
      return;
    }
    if (this.a.length < m * m) {
      this.a = new Float64Array(m * m);
      this.m = new Float64Array(m * m);
    }
    const a = this.a;
    for (let i = 0; i < m; i++) {
      for (let j = i; j < m; j++) {
        const v = this.coupling(this.order[start + i], this.order[start + j]);
        a[i * m + j] = v;
        a[j * m + i] = v;
      }
      // Where each row starts: a one-sided row begins *inactive* (at the bound that contains zero), so two rows
      // that pull on the same shaft in different ways (a motor and a speed limit) never begin as a contradictory
      // pair of equalities; the others begin free.
      const k = this.order[start + i];
      this.state[i] = this.hi[k] - this.lo[k] <= 0 ? DEAD : this.lo[k] === 0 ? AT_LO : this.hi[k] === 0 ? AT_HI : FREE;
      this.x[i] = 0; // λ of the cluster's i-th row
    }
    const maxIter = 2 * m + 6;
    for (let iter = 0; iter < maxIter; iter++) {
      // unknowns: the FREE rows; the others sit at a bound
      let nf = 0;
      for (let i = 0; i < m; i++) {
        if (this.state[i] === FREE) this.free[nf++] = i;
        else if (this.state[i] === DEAD) this.x[i] = this.lo[this.order[start + i]];
        else this.x[i] = this.state[i] === AT_LO ? this.lo[this.order[start + i]] : this.hi[this.order[start + i]];
      }
      if (nf > 0) {
        for (let r = 0; r < nf; r++) {
          const i = this.free[r];
          let rhs = -this.c0[i];
          for (let j = 0; j < m; j++) if (this.state[j] !== FREE) rhs -= a[i * m + j] * this.x[j];
          this.b[r] = rhs;
          for (let c = 0; c < nf; c++) this.m[r * nf + c] = a[i * m + this.free[c]];
        }
        solveDense(this.m, this.b, nf);
        for (let r = 0; r < nf; r++) this.x[this.free[r]] = this.b[r];
      }
      // the free row that is furthest beyond its bounds goes to that bound (one pivot per round keeps the
      // active set from overshooting)
      let worst = -1;
      let worstBy = 0;
      let worstState = FREE;
      for (let r = 0; r < nf; r++) {
        const i = this.free[r];
        const k = this.order[start + i];
        const eps = 1e-12 * (1 + Math.abs(this.x[i]));
        const below = this.lo[k] - this.x[i];
        const above = this.x[i] - this.hi[k];
        if (below > eps && below > worstBy) {
          worst = i;
          worstBy = below;
          worstState = AT_LO;
        } else if (above > eps && above > worstBy) {
          worst = i;
          worstBy = above;
          worstState = AT_HI;
        }
      }
      if (worst >= 0) {
        this.state[worst] = worstState;
        continue;
      }
      // a saturated row whose residual has the wrong sign is released again (the worst one first)
      let release = -1;
      let releaseBy = 0;
      for (let i = 0; i < m; i++) {
        if (this.state[i] === FREE || this.state[i] === DEAD) continue;
        let c = this.c0[i];
        for (let j = 0; j < m; j++) c += a[i * m + j] * this.x[j];
        const eps = 1e-9 * (1 + Math.abs(this.c0[i]));
        const wrong = this.state[i] === AT_LO ? -c : c;
        if (wrong > eps && wrong > releaseBy) {
          release = i;
          releaseBy = wrong;
        }
      }
      if (release < 0) break;
      this.state[release] = FREE;
    }
    for (let i = 0; i < m; i++) {
      const k = this.order[start + i];
      this.x[i] = Math.min(Math.max(this.x[i], this.lo[k]), this.hi[k]);
    }
    if (!this.consistent(start, m)) this.sweep(start, m);
    for (let i = 0; i < m; i++) this.lambda[this.order[start + i]] = this.x[i];
  }

  /** Does `x` satisfy the complementarity conditions (within a tolerance)? */
  private consistent(start: number, m: number): boolean {
    const a = this.a;
    for (let i = 0; i < m; i++) {
      const k = this.order[start + i];
      let c = this.c0[i];
      for (let j = 0; j < m; j++) c += a[i * m + j] * this.x[j];
      const tol = 1e-7 * (1 + Math.abs(this.c0[i]));
      const atLo = this.x[i] <= this.lo[k] + 1e-12 * (1 + Math.abs(this.lo[k]));
      const atHi = this.x[i] >= this.hi[k] - 1e-12 * (1 + Math.abs(this.hi[k]));
      if (atLo && atHi) continue; // pinned
      if (atLo) {
        if (c < -tol) return false;
      } else if (atHi) {
        if (c > tol) return false;
      } else if (Math.abs(c) > tol) return false;
    }
    return true;
  }

  /**
   * Projected Gauss-Seidel from the current impulses: slower than the active set on a stiff chain, but it copes with
   * rows that are parallel (a brake and a motor holding opposite speeds on one shaft), where the dense system is
   * singular. Used only when the direct solve did not end in a consistent state.
   */
  private sweep(start: number, m: number): void {
    const a = this.a;
    for (let iter = 0; iter < 80; iter++) {
      let moved = 0;
      for (let i = 0; i < m; i++) {
        const k = this.order[start + i];
        const d = a[i * m + i];
        if (!(d > 1e-300)) continue;
        let c = this.c0[i];
        for (let j = 0; j < m; j++) c += a[i * m + j] * this.x[j];
        const next = Math.min(Math.max(this.x[i] - c / d, this.lo[k]), this.hi[k]);
        moved = Math.max(moved, Math.abs(next - this.x[i]) * Math.sqrt(d));
        this.x[i] = next;
      }
      if (moved < 1e-13) break;
    }
  }
}

/**
 * Solve the n×n system `m·x = b` in place (`b` becomes x) by Gaussian elimination with partial pivoting. A pivot that
 * vanishes (a redundant row: two locked links closing a loop) leaves its unknown at zero instead of blowing up.
 */
export function solveDense(m: Float64Array, b: Float64Array, n: number): void {
  let scale = 0;
  for (let i = 0; i < n; i++) scale = Math.max(scale, Math.abs(m[i * n + i]));
  const tiny = 1e-14 * (scale || 1);
  const reg = 1e-15 * (scale || 1);
  for (let i = 0; i < n; i++) m[i * n + i] += reg;
  for (let col = 0; col < n; col++) {
    let piv = col;
    let best = Math.abs(m[col * n + col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(m[r * n + col]);
      if (v > best) {
        best = v;
        piv = r;
      }
    }
    if (best < tiny) {
      // singular column: pin the unknown to zero
      for (let c = 0; c < n; c++) m[col * n + c] = 0;
      m[col * n + col] = 1;
      b[col] = 0;
      continue;
    }
    if (piv !== col) {
      for (let c = col; c < n; c++) {
        const t = m[col * n + c];
        m[col * n + c] = m[piv * n + c];
        m[piv * n + c] = t;
      }
      const t = b[col];
      b[col] = b[piv];
      b[piv] = t;
    }
    const d = m[col * n + col];
    for (let r = col + 1; r < n; r++) {
      const f = m[r * n + col] / d;
      if (f === 0) continue;
      for (let c = col; c < n; c++) m[r * n + c] -= f * m[col * n + c];
      b[r] -= f * b[col];
    }
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let c = i + 1; c < n; c++) s -= m[i * n + c] * b[c];
    b[i] = s / m[i * n + i];
  }
}

function grow(a: Float64Array, min: number): Float64Array {
  if (a.length >= min) return a;
  const out = new Float64Array(Math.max(min, a.length * 2));
  out.set(a);
  return out;
}
function growI(a: Int32Array, min: number): Int32Array {
  if (a.length >= min) return a;
  const out = new Int32Array(Math.max(min, a.length * 2));
  out.set(a);
  return out;
}
function growU8(a: Uint8Array, min: number): Uint8Array {
  if (a.length >= min) return a;
  const out = new Uint8Array(Math.max(min, a.length * 2));
  out.set(a);
  return out;
}
