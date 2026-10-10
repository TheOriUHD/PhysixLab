/**
 * The drive network — the shaft / torque graph the powered parts talk through.
 *
 * Engines, motors, clutches, gearboxes, differentials, brakes, servos and actuators never refer to one another by id.
 * Each of them names the *shafts* it is connected to ("crank", "driveshaft", "left" …) and registers, every fixed
 * step, what it does to them:
 *
 *   - `inertia(shaft, I)`        rotating mass that belongs to a (virtual) shaft: a flywheel, a gear train;
 *   - `torque(shaft, T0, b)`     a source: torque T = T0 − b·ω' (b ≥ 0 is treated implicitly, which keeps back-EMF
 *                                droop, springs and fluid drag stable at any step size);
 *   - rows (`gear`, `couple`, `drive`, `limit` …) linear relations between shaft speeds, optionally bounded by a
 *                                torque: a gear ratio, a locked differential, a slipping clutch, a brake, a motor
 *                                that holds a speed, a travel stop.
 *
 * After every component has registered, `solve()` finds the new shaft speeds with the direct solver in `solver.ts` and
 * delivers the impulses to the physical world. A shaft is either *virtual* (a named flywheel with its own state; the
 * engine's crank, a gearbox shaft) or *physical* (bound to a hinge or slider joint: its speed is the joint's relative
 * speed and its inertia is measured from the two bodies; the impulse goes to them as ±J).
 *
 * Shaft names are scoped to the **assembly** — the bodies connected by joints (a static frame counts: an engine bolted to
 * the ground drives the flywheel hinged to it) — so two copies of a car in one
 * scene each have their own "crank"; a name that starts with `@` is shared by the whole scene.
 */
import type { Vec3 } from '../../../core/math';
import type { JointType } from '../../../model/types';
import type { WorldState } from '../../world/state';
import { JointBinding } from './bindings';
import { DriveSolver } from './solver';

/** Smallest inertia a virtual shaft may have (kg·m²): keeps a bare shaft from being singular. */
export const MIN_INERTIA = 1e-4;

const RIGID: ReadonlySet<JointType> = new Set(['fixed', 'hinge', 'slider', 'ball']);

export class Shaft {
  /** Speed of a virtual shaft in rad/s (state: components may set it, snapshots keep it). */
  omega = 0;
  refs = 0;
  // per-step accumulators (virtual shafts: all three; physical shafts: sources only)
  inertia = 0;
  torque = 0;
  damping = 0;
  /** Solver index during the current step. */
  node = -1;
  /** Inverse effective inertia of a joint shaft in the current step. */
  invI = 0;
  /** Speed change gravity will cause in the coming step (joint shafts; compensated by the controllers). */
  ext = 0;
  /** A virtual shaft that has not been through a solve yet: its first speed is made consistent with its neighbours. */
  fresh = true;
  /** Impulse the solver delivered to this shaft in the last step (N·m·s) — what the physical world received. */
  impulse = 0;
  private cachedAt = -1;
  private cached = 0;

  constructor(
    private readonly net: DriveNetwork,
    readonly key: string,
    /** The name the user gave it ('' for a joint shaft). */
    readonly name: string,
    readonly bind: JointBinding | null,
  ) {}

  get kind(): 'rot' | 'lin' {
    return this.bind ? this.bind.kind : 'rot';
  }
  get physical(): boolean {
    return this.bind !== null;
  }
  /** False for a joint shaft whose joint is gone or broke. */
  get alive(): boolean {
    return this.bind ? this.bind.alive() : true;
  }

  /** Current speed (rad/s or m/s). A joint shaft is measured from its bodies, once per phase. */
  get speed(): number {
    if (!this.bind) return this.omega;
    if (this.cachedAt !== this.net.phase) {
      this.cached = this.bind.speed();
      this.cachedAt = this.net.phase;
    }
    return this.cached;
  }
  set speed(v: number) {
    this.omega = v;
  }

  /** World axis of a joint shaft (unit); zero for a virtual shaft. */
  axisWorld(out: Vec3 = [0, 0, 0]): Vec3 {
    return this.bind ? this.bind.axis(out) : out;
  }
  /** World position of a joint shaft's pivot. */
  pivotWorld(out: Vec3 = [0, 0, 0]): Vec3 {
    return this.bind ? this.bind.anchorWorld(out) : out;
  }

  /** Effective inertia (kg·m² or kg) the network moves this shaft with; Infinity for an immovable joint shaft. */
  get effInertia(): number {
    if (!this.bind) return Math.max(this.inertia, MIN_INERTIA);
    const inv = this.bind.invInertia();
    return inv > 1e-12 ? 1 / inv : Infinity;
  }

  /** Angle (rad) or extension (m) of a joint shaft, 0 at the pose the simulation started in. */
  get position(): number {
    return this.bind ? this.bind.position() : 0;
  }

  /** Forget the cached measurement (the bodies moved). */
  invalidate(): void {
    this.cachedAt = -1;
  }
}

/** One linear row of the current step; pooled, valid until the next `begin()`. */
export class Row {
  count = 0;
  readonly shafts: Shaft[] = [];
  readonly coef: number[] = [0, 0, 0, 0];
  rhs = 0;
  lo = 0;
  hi = 0;
  /** Impulse applied by the row (N·m·s or N·s) — the sign convention is that of the row's coefficients. */
  lambda = 0;
  /** What was left over after the solve (≈ 0 unless the row saturated). */
  residual = 0;
  /** True once the row hit a bound: the clutch slips, the brake overpowered, the motor out of torque. */
  saturated = false;
  /** Which bounds count as "saturated": both (clutch, brake, motor) or only the active side of a one-sided limit. */
  satSides: 'both' | 'lo' | 'hi' = 'both';
  private k = -1;
  constructor(private readonly net: DriveNetwork) {}

  /** Add the term `j·ω'(shaft)`. */
  add(shaft: Shaft, j: number): this {
    this.shafts[this.count] = shaft;
    this.coef[this.count] = j;
    this.count++;
    return this;
  }
  /** Torque (or force) the row applied to its `index`-th term's shaft, averaged over the step. */
  torqueOn(index: number): number {
    return this.net.dt > 0 ? (this.coef[index] * this.lambda) / this.net.dt : 0;
  }
  /** The row's impulse as a torque (N·m / N): `λ / dt`. */
  get torque(): number {
    return this.net.dt > 0 ? this.lambda / this.net.dt : 0;
  }
  /** @internal */
  setIndex(k: number): void {
    this.k = k;
  }
  /** @internal */
  get index(): number {
    return this.k;
  }
}

/** Overflow-safe bound for an unbounded row (a bilateral constraint). */
export const UNBOUNDED = 1e300;
const INF = UNBOUNDED;

export class DriveNetwork {
  readonly solver = new DriveSolver();
  /** Bumped by `begin()` and by `solve()`: a measurement is valid within one phase. */
  phase = 0;
  dt = 1 / 120;
  private virtual = new Map<string, Shaft>();
  private physicalShafts = new Map<string, Shaft>();
  /** Every shaft in creation order (the solver's node order — deterministic). */
  private list: Shaft[] = [];
  private pool: Row[] = [];
  private rowCount = 0;
  /** Saved speeds waiting for their shaft to be created again (a restored world creates shafts lazily). */
  private pending = new Map<string, number>();
  private roots = new Map<string, string>();
  private rootsVersion = -1;

  constructor(private readonly s: WorldState) {}

  // ---- shafts --------------------------------------------------------------------------------------

  /** The assembly (set of bodies connected by rigid joints) a body belongs to: its first-created member. */
  scopeOf(ownerKind: 'body' | 'joint', ownerId: string): string {
    if (this.rootsVersion !== this.s.layoutVersion) this.buildRoots();
    let body = ownerId;
    if (ownerKind === 'joint') {
      const j = this.s.joints.get(ownerId);
      body = j?.def.bodyA ?? j?.def.bodyB ?? `joint:${ownerId}`;
    }
    return this.roots.get(body) ?? body;
  }

  private buildRoots(): void {
    this.rootsVersion = this.s.layoutVersion;
    const parent = new Map<string, string>();
    const find = (id: string): string => {
      let p = parent.get(id) ?? id;
      while (p !== (parent.get(p) ?? p)) p = parent.get(p) ?? p;
      parent.set(id, p);
      return p;
    };
    const seq = (id: string) => this.s.bodies.get(id)?.seq ?? Infinity;
    for (const j of this.s.jointOrder) {
      if (j.broken || !RIGID.has(j.def.type) || !j.def.bodyA || !j.def.bodyB) continue;
      const a = this.s.bodies.get(j.def.bodyA);
      const b = this.s.bodies.get(j.def.bodyB);
      if (!a || !b) continue;
      const ra = find(a.id);
      const rb = find(b.id);
      if (ra === rb) continue;
      // the member created first becomes the root, so the scope id does not change when more bodies join
      if (seq(ra) <= seq(rb)) parent.set(rb, ra);
      else parent.set(ra, rb);
    }
    this.roots = new Map();
    for (const r of this.s.order) this.roots.set(r.id, find(r.id));
  }

  /** The virtual shaft `name` of an owner's assembly (created on first use). */
  virtualShaft(ownerKind: 'body' | 'joint', ownerId: string, name: string): Shaft {
    const key = name.startsWith('@') ? name : `${this.scopeOf(ownerKind, ownerId)}/${name}`;
    let sh = this.virtual.get(key);
    if (!sh) {
      sh = new Shaft(this, key, name, null);
      const saved = this.pending.get(key);
      if (saved !== undefined) {
        // a snapshot restore: the shaft comes back with the speed it had, already consistent with its neighbours
        sh.omega = saved;
        sh.fresh = false;
        this.pending.delete(key);
      }
      this.virtual.set(key, sh);
      this.list.push(sh);
    }
    return sh;
  }

  /** The shaft of a hinge or slider joint; null for any other joint type or a joint that is gone. */
  jointShaft(jointId: string): Shaft | null {
    const def = this.s.joints.get(jointId)?.def;
    if (!def || (def.type !== 'hinge' && def.type !== 'slider')) return null;
    let sh = this.physicalShafts.get(jointId);
    if (sh && !sh.alive) return null;
    if (!sh) {
      sh = new Shaft(this, `joint:${jointId}`, '', new JointBinding(this.s, jointId));
      this.physicalShafts.set(jointId, sh);
      this.list.push(sh);
    }
    return sh;
  }

  // ---- per-step registration -----------------------------------------------------------------------

  /** Start a step: clear the registrations of the previous one. */
  begin(dt: number): void {
    this.dt = dt;
    this.phase++;
    this.rowCount = 0;
    for (const sh of this.list) {
      sh.inertia = 0;
      sh.torque = 0;
      sh.damping = 0;
      sh.impulse = 0;
    }
  }

  /** Rotating mass on a virtual shaft. */
  inertia(shaft: Shaft, i: number): void {
    if (!shaft.bind && i > 0) shaft.inertia += i;
  }

  /** A source on a shaft: torque `t0 − damping·ω'` (damping ≥ 0, treated implicitly). */
  torque(shaft: Shaft, t0: number, damping = 0): void {
    shaft.torque += t0;
    if (damping > 0) shaft.damping += damping;
  }

  /** A new row `Σ jᵢ·ω'ᵢ = rhs` with impulse bounds; add its terms with `.add(shaft, j)`. */
  row(rhs: number, lo: number, hi: number): Row {
    let r = this.pool[this.rowCount];
    if (!r) this.pool[this.rowCount] = r = new Row(this);
    this.rowCount++;
    r.count = 0;
    r.rhs = rhs;
    r.lo = lo;
    r.hi = hi;
    r.lambda = 0;
    r.residual = 0;
    r.saturated = false;
    r.satSides = 'both';
    r.setIndex(-1);
    return r;
  }

  /** ω_a = ratio·ω_b, rigid (a gear pair: the torque on b is `ratio` times the torque on a). */
  gear(a: Shaft, b: Shaft, ratio: number): Row {
    return this.row(0, -INF, INF).add(a, 1).add(b, -ratio);
  }
  /** ω_a = ω_b up to `maxTorque` (N·m): a friction clutch. Saturated = slipping. */
  couple(a: Shaft, b: Shaft, maxTorque: number): Row {
    const cap = Math.max(0, maxTorque) * this.dt;
    return this.row(0, -cap, cap).add(a, 1).add(b, -1);
  }
  /** Drive ω_a toward `target` with at most `maxTorque`: a motor holding a speed, a brake (target 0). */
  drive(a: Shaft, target: number, maxTorque: number): Row {
    const cap = Math.max(0, maxTorque) * this.dt;
    return this.row(target, -cap, cap).add(a, 1);
  }
  /** Keep ω_a ≤ max (`side` = 1) or ≥ min (`side` = −1) with at most `maxTorque`: a speed limit, a travel stop. */
  limit(a: Shaft, bound: number, side: 1 | -1, maxTorque: number): Row {
    const cap = Math.max(0, maxTorque) * this.dt;
    // C = ω − bound ≤ 0 needs λ ≤ 0 ; C ≥ 0 needs λ ≥ 0
    const r = this.row(bound, side === 1 ? -cap : 0, side === 1 ? 0 : cap).add(a, 1);
    r.satSides = side === 1 ? 'lo' : 'hi';
    return r;
  }

  // ---- solving -------------------------------------------------------------------------------------

  /** Solve the step and deliver the impulses to the bodies. */
  solve(): void {
    const sv = this.solver;
    const dt = this.dt;
    // The engine integrates a step in N = (solver iterations × sub-steps) equal parts, so what gravity adds to the
    // *average* speed of the step (the one that sets the displacement) is (N+1)/(2N) of g·dt, not all of it.
    const n =
      Math.max(1, Math.round(this.s.settings.solverIterations)) * Math.max(1, Math.round(this.s.settings.substeps));
    const meanShare = (n + 1) / (2 * n);
    if (this.list.some((sh) => sh.fresh && !sh.bind)) this.initialise();
    sv.clear();
    this.addNodes(dt, meanShare);
    this.addRows();
    sv.solve();
    this.collect();
    this.phase++; // measurements taken before the engine step are stale after it
    for (const sh of this.list) sh.invalidate();
    this.pending.clear(); // anything not claimed by a shaft in the first step after a restore belongs to nothing
    this.sweep();
  }

  /**
   * A shaft that has just appeared starts with whatever speed its owner gave it (0, or idle for an engine), which
   * need not agree with the shafts it is rigidly connected to — a wheel that already turns, a differential whose
   * outputs were given different speeds. Left alone, the first solve would settle the disagreement as a collision,
   * throwing momentum between the physical bodies. Instead the new shafts adapt to their neighbours *first*: a
   * one-off solve in which everything else (the bodies, shafts that were already running) is held fixed.
   */
  private initialise(): void {
    const sv = this.solver;
    sv.clear();
    for (const sh of this.list) {
      if (sh.bind) {
        sh.invI = sh.bind.alive() ? sh.bind.invInertia() : 0;
        sh.node = sv.addNode(0, sh.bind.alive() ? sh.speed : 0);
      } else {
        const free = sh.fresh;
        sh.node = sv.addNode(free ? 1 / Math.max(sh.inertia, MIN_INERTIA) : 0, sh.omega);
      }
    }
    this.addRows(true);
    sv.solve();
    for (const sh of this.list) {
      if (!sh.bind && sh.fresh) {
        sh.omega = sv.v[sh.node];
        sh.fresh = false;
      }
    }
  }

  /** Solver nodes: free speed after the explicit part of the sources, inverse effective inertia. */
  private addNodes(dt: number, meanShare: number): void {
    const sv = this.solver;
    for (const sh of this.list) {
      let inertia: number;
      let w: number;
      if (sh.bind) {
        sh.invI = sh.bind.alive() ? sh.bind.invInertia() : 0;
        w = sh.bind.alive() ? sh.speed : 0;
        if (sh.invI <= 1e-12) {
          sh.invI = 0;
          sh.ext = 0;
          sh.node = sv.addNode(0, w);
          continue;
        }
        inertia = 1 / sh.invI;
        sh.ext = sh.bind.gravityDelta(dt) * meanShare;
        w += sh.ext; // gravity acts after our impulse: aim the step's mean speed at the target
      } else {
        inertia = Math.max(sh.inertia, MIN_INERTIA);
        w = sh.omega;
      }
      const m = inertia + dt * sh.damping;
      sh.node = sv.addNode(1 / m, (inertia * w + dt * sh.torque) / m);
    }
  }

  /** Hand the registered rows to the solver; `rigidOnly` leaves out the torque-limited ones (clutches, brakes, motors). */
  private addRows(rigidOnly = false): void {
    const sv = this.solver;
    for (let i = 0; i < this.rowCount; i++) {
      const r = this.pool[i];
      if (rigidOnly && !(r.lo <= -INF / 2 && r.hi >= INF / 2)) {
        r.setIndex(-1);
        continue;
      }
      const k = sv.addRow(r.rhs, r.lo, r.hi);
      r.setIndex(k);
      for (let e = 0; e < r.count; e++) sv.addEntry(k, r.shafts[e].node, r.coef[e]);
    }
  }

  /** Read the solution back: row impulses, new virtual speeds, impulses delivered to the bodies. */
  private collect(): void {
    const sv = this.solver;
    for (let i = 0; i < this.rowCount; i++) {
      const r = this.pool[i];
      const k = r.index;
      r.lambda = sv.lambda[k];
      r.residual = sv.residual(k);
      const span = r.hi - r.lo;
      const atLo = r.satSides !== 'hi' && r.lambda - r.lo <= 1e-9 * span;
      const atHi = r.satSides !== 'lo' && r.hi - r.lambda <= 1e-9 * span;
      r.saturated = span > 0 && span < INF / 2 && (atLo || atHi);
    }
    for (const sh of this.list) {
      const v = sv.v[sh.node];
      if (sh.bind && sh.invI > 0) {
        const impulse = (v - sh.speed - sh.ext) / sh.invI;
        sh.impulse = impulse;
        sh.bind.apply(impulse);
      }
      if (!sh.bind || sh.invI > 0) sh.omega = v;
    }
  }

  /** Drop shafts nobody uses any more (and the joint shafts of joints that are gone). */
  private sweep(): void {
    let dirty = false;
    for (const [k, sh] of this.virtual)
      if (sh.refs <= 0) {
        this.virtual.delete(k);
        dirty = true;
      }
    for (const [k, sh] of this.physicalShafts)
      if (!sh.alive && !this.s.joints.has(k)) {
        this.physicalShafts.delete(k);
        dirty = true;
      }
    if (dirty)
      this.list = this.list.filter((sh) =>
        sh.bind ? this.physicalShafts.has(sh.bind.jointId) : this.virtual.has(sh.key),
      );
  }

  // ---- snapshots -----------------------------------------------------------------------------------

  /** Speeds of the virtual shafts, by key. */
  save(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, sh] of this.virtual) out[k] = sh.omega;
    return out;
  }
  load(saved: Record<string, number>): void {
    for (const [k, w] of Object.entries(saved)) {
      if (!Number.isFinite(w)) continue;
      const sh = this.virtual.get(k);
      if (sh) {
        sh.omega = w;
        sh.fresh = false; // a saved speed is already consistent with its neighbours
      } else this.pending.set(k, w);
    }
  }

  /** Forget everything (the world is being replaced). */
  clear(): void {
    this.virtual.clear();
    this.physicalShafts.clear();
    this.list = [];
    this.rowCount = 0;
    this.rootsVersion = -1;
    // `pending` survives: `clear()` is called first on a restore, and the saved speeds are loaded right after
  }

  /** Number of shafts alive (tests). */
  get shaftCount(): number {
    return this.list.length;
  }
}

/**
 * What a component sees of the network (`ctx.drive`): the same registration calls, with the shafts it acquired
 * released automatically when the component goes away.
 */
export class DriveAccess {
  private readonly held = new Set<Shaft>();
  constructor(
    private readonly net: DriveNetwork,
    private readonly ownerKind: 'body' | 'joint',
    private readonly ownerId: string,
  ) {}

  get dt(): number {
    return this.net.dt;
  }

  /** The virtual shaft called `name` in this component's assembly (`@name` is scene-wide). */
  shaft(name: string): Shaft {
    const sh = this.net.virtualShaft(this.ownerKind, this.ownerId, name || 'shaft');
    if (!this.held.has(sh)) {
      this.held.add(sh);
      sh.refs++;
    }
    return sh;
  }
  /** The shaft of the joint this component sits on (hinge → rotational, slider → linear); null otherwise. */
  own(): Shaft | null {
    return this.ownerKind === 'joint' ? this.net.jointShaft(this.ownerId) : null;
  }
  /** The shaft of any hinge / slider joint by id. */
  jointShaft(jointId: string): Shaft | null {
    return this.net.jointShaft(jointId);
  }
  /** Let go of every shaft this component acquired (call from `paramsChanged` before re-acquiring by new names). */
  releaseAll(): void {
    for (const sh of this.held) sh.refs--;
    this.held.clear();
  }

  inertia(shaft: Shaft, i: number): void {
    this.net.inertia(shaft, i);
  }
  torque(shaft: Shaft, t0: number, damping = 0): void {
    this.net.torque(shaft, t0, damping);
  }
  row(rhs: number, lo: number, hi: number): Row {
    return this.net.row(rhs, lo, hi);
  }
  gear(a: Shaft, b: Shaft, ratio: number): Row {
    return this.net.gear(a, b, ratio);
  }
  couple(a: Shaft, b: Shaft, maxTorque: number): Row {
    return this.net.couple(a, b, maxTorque);
  }
  drive(a: Shaft, target: number, maxTorque: number): Row {
    return this.net.drive(a, target, maxTorque);
  }
  limit(a: Shaft, bound: number, side: 1 | -1, maxTorque: number): Row {
    return this.net.limit(a, bound, side, maxTorque);
  }
}
