/**
 * The context a component runtime works through. It is the *only* way a component touches the world: bodies by id
 * (`BodyHandle`), forces / impulses / velocities, ray casts, contact queries, events, inputs, the seeded RNG, paths
 * and the component's own published state. Handles stay valid across steps (they look the body up on every call and
 * report `alive: false` once it is gone), so a component may keep a handle but never an engine object.
 *
 * Everything here is deterministic for a given scene, seed and input stream: forces are applied as impulses
 * (`F·dt` over the fixed step) so they never fight the engine's persistent force accumulators, and `ctx.random()`
 * draws from the world's RNG.
 */
import { qconj, qmul, qnorm, type Quat, type Vec3 } from '../../core/math';
import type { Rng } from '../../core/rng';
import { componentDef } from '../../model/componentRegistry';
import type { PathCurve } from '../../model/path';
import type { BodyEntity, BodyType, ComponentParams, ComponentSpec, ComponentValue } from '../../model/types';
import type { RayHit, RaycastOptions } from '../protocol';
import { raycast as castRay, contactsOf, type ContactPoint } from '../world/queries';
import type { WorldState } from '../world/state';
import { fixedDt } from '../world/stepping';
import { pos, rot, rq, rv } from '../world/util';
import { watchContacts } from '../world/events';
import type { ComponentHost } from './host';
// -- ZN: the zone system (races, score, respawn, spawn)
import type { ZoneSystem } from '../zones/system';
// -- CP: the drive network (shafts / torque graph) and the body mass trim
import { setTotalMass } from '../world/massTrim';
import type { DriveAccess } from './drive/network';

export type { ContactPoint };

/** A body as a component sees it. */
export interface BodyHandle {
  readonly id: string;
  /** False once the body has been removed from the world (every member but `def` then returns neutral values). */
  readonly alive: boolean;
  /** The document definition (immutable). Throws once the body is gone: check `alive` first. */
  readonly def: Readonly<BodyEntity>;
  readonly type: BodyType;
  /** Mass in kg; 0 for static and kinematic bodies. */
  readonly mass: number;
  position(out?: Vec3): Vec3;
  rotation(out?: Quat): Quat;
  linvel(out?: Vec3): Vec3;
  angvel(out?: Vec3): Vec3;
  /** Velocity of the material point of the body that is at world position `point`. */
  velocityAt(point: Vec3, out?: Vec3): Vec3;
  /** A force (N, world frame) acting for this step, at the centre of mass or at the world point `at`. */
  applyForce(force: Vec3, at?: Vec3): void;
  /** A torque (N·m, world frame) acting for this step. */
  applyTorque(torque: Vec3): void;
  /** An instantaneous impulse (N·s, world frame), at the centre of mass or at the world point `at`. */
  applyImpulse(impulse: Vec3, at?: Vec3): void;
  applyTorqueImpulse(torque: Vec3): void;
  /** Set the linear (and optionally angular) velocity, world frame. */
  setVelocity(linear: Vec3, angular?: Vec3): void;
  /**
   * Move the body so that it is at `position` (and `rotation`) at the end of this step, by setting its velocity —
   * how kinematic bodies are driven: contacts see the real velocity, so friction carries riders along.
   */
  driveTo(position: Vec3, rotation?: Quat): void;
  /** Place the body instantly (velocities are kept). */
  teleport(position: Vec3, rotation?: Quat): void;
  wake(): void;
  // -- CP: variable mass
  /**
   * Change the body's total mass to `kg` (dynamic bodies only): the centre of mass stays, the inertia scales in
   * proportion — fuel burning off, a payload released. The engine keeps the new mass through snapshots.
   */
  setMass(kg: number): void;
}

/** A joint as a component sees it (read-only measurements). */
export interface JointHandle {
  readonly id: string;
  readonly alive: boolean;
  /** Hinge angle (rad), slider position (m), spring / rope length (m). */
  readonly value: number;
  readonly speed: number;
  readonly force: number;
  readonly broken: boolean;
  // -- CP: the bodies the joint connects (null = the world)
  readonly bodyA: string | null;
  readonly bodyB: string | null;
}

export interface ComponentContext {
  /** The body or joint the component is attached to, and the component's own id / type. */
  readonly ownerKind: 'body' | 'joint';
  readonly ownerId: string;
  readonly componentId: string;
  readonly type: string;

  /** The component's current parameters (live: they follow edits made while the simulation runs). */
  readonly params: Readonly<ComponentParams>;
  /** Typed parameter readers; a missing or mistyped value falls back to the field's default. */
  num(key: string): number;
  bool(key: string): boolean;
  str(key: string): string;
  vec3(key: string): Vec3;
  /** A `curve` field: sorted [x, y] points. */
  curve(key: string): readonly (readonly number[])[];
  /** Evaluate a `curve` field at `x` (piecewise linear, clamped to its end points). */
  curveAt(key: string, x: number): number;

  /** Simulated seconds: the start of the step inside `prestep`, its end inside `poststep` and `onEvent`. */
  readonly time: number;
  /** The fixed step length, seconds. */
  readonly dt: number;
  /** Fixed steps taken so far. */
  readonly step: number;

  /** The owning body (null for a joint component) and joint (null for a body component). */
  readonly body: BodyHandle | null;
  readonly joint: JointHandle | null;
  /** Any body by id (null if it does not exist). */
  bodyById(id: string): BodyHandle | null;
  jointById(id: string): JointHandle | null;
  /** A path of the scene as a world-space curve (null if there is no such path). */
  path(id: string): PathCurve | null;

  raycast(origin: Vec3, dir: Vec3, maxDist: number, options?: RaycastOptions): RayHit | null;
  /** The contacts a body is in right now (default: the owner). */
  contacts(bodyId?: string): ContactPoint[];
  /** Ask the world to generate contact events (reference-counted; undone automatically when the component goes away). */
  watchContacts(on?: boolean): void;

  /** Raise a `component` event for the page (`SimClient` re-emits it as an `'event'`). */
  emit(name: string, data?: unknown): void;
  // -- ZN: races, score, respawn points, spawning and rigid unit moves, shared by every zone and the world bounds
  readonly zones: ZoneSystem;
  // -- CP: the shaft / torque graph the powered parts register with (see `drive/network.ts`)
  readonly drive: DriveAccess;
  readonly input: {
    /** Is the key (`KeyboardEvent.code`) held? */
    key(code: string): boolean;
    /** Analog axis by name, 0 when unset. */
    axis(name: string): number;
  };
  /** Uniform [0, 1) from the world's seeded generator. */
  random(): number;
  readonly rng: Rng;
  /** Publish values for the page (inspector gauges, telemetry, sensors): only changes are sent. */
  readonly state: {
    set(values: ArrayLike<number>): void;
    setJson(value: unknown): void;
  };
}

// ── implementation ──────────────────────────────────────────────────────────────────────────────────

class BodyHandleImpl implements BodyHandle {
  constructor(
    private s: WorldState,
    readonly id: string,
  ) {}

  private get rec() {
    return this.s.bodies.get(this.id);
  }
  get alive(): boolean {
    return !!this.rec;
  }
  get def(): Readonly<BodyEntity> {
    const r = this.rec;
    if (!r) throw new Error(`body "${this.id}" is gone`);
    return r.def;
  }
  get type(): BodyType {
    return this.rec?.def.bodyType ?? 'static';
  }
  get mass(): number {
    return this.rec?.mass ?? 0;
  }
  position(out: Vec3 = [0, 0, 0]): Vec3 {
    const r = this.rec;
    if (!r) return out;
    const t = r.rb.translation();
    out[0] = t.x;
    out[1] = t.y;
    out[2] = t.z;
    return out;
  }
  rotation(out: Quat = [0, 0, 0, 1]): Quat {
    const r = this.rec;
    if (!r) return out;
    const q = r.rb.rotation();
    out[0] = q.x;
    out[1] = q.y;
    out[2] = q.z;
    out[3] = q.w;
    return out;
  }
  linvel(out: Vec3 = [0, 0, 0]): Vec3 {
    const r = this.rec;
    if (!r) return out;
    const v = r.rb.linvel();
    out[0] = v.x;
    out[1] = v.y;
    out[2] = v.z;
    return out;
  }
  angvel(out: Vec3 = [0, 0, 0]): Vec3 {
    const r = this.rec;
    if (!r) return out;
    const v = r.rb.angvel();
    out[0] = v.x;
    out[1] = v.y;
    out[2] = v.z;
    return out;
  }
  velocityAt(point: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
    const r = this.rec;
    if (!r) return out;
    const v = r.rb.velocityAtPoint(rv(point));
    out[0] = v.x;
    out[1] = v.y;
    out[2] = v.z;
    return out;
  }
  private get dynamic() {
    const r = this.rec;
    return r && r.def.bodyType === 'dynamic' && !r.disabled ? r : null;
  }
  applyForce(force: Vec3, at?: Vec3): void {
    const dt = fixedDt(this.s);
    this.applyImpulse([force[0] * dt, force[1] * dt, force[2] * dt], at);
  }
  applyTorque(torque: Vec3): void {
    const dt = fixedDt(this.s);
    this.applyTorqueImpulse([torque[0] * dt, torque[1] * dt, torque[2] * dt]);
  }
  applyImpulse(impulse: Vec3, at?: Vec3): void {
    const r = this.dynamic;
    if (!r) return;
    if (at) r.rb.applyImpulseAtPoint(rv(impulse), rv(at), true);
    else r.rb.applyImpulse(rv(impulse), true);
  }
  applyTorqueImpulse(torque: Vec3): void {
    this.dynamic?.rb.applyTorqueImpulse(rv(torque), true);
  }
  setVelocity(linear: Vec3, angular?: Vec3): void {
    const r = this.rec;
    if (!r) return;
    r.rb.setLinvel(rv(linear), true);
    if (angular) r.rb.setAngvel(rv(angular), true);
  }
  driveTo(position: Vec3, rotation?: Quat): void {
    const r = this.rec;
    if (!r) return;
    const dt = fixedDt(this.s);
    const p = pos(r.rb);
    r.rb.setLinvel({ x: (position[0] - p[0]) / dt, y: (position[1] - p[1]) / dt, z: (position[2] - p[2]) / dt }, true);
    if (rotation) {
      // angular velocity that turns the current orientation into the target one within the step
      let dq = qmul(rotation, qconj(rot(r.rb)));
      if (dq[3] < 0) dq = [-dq[0], -dq[1], -dq[2], -dq[3]];
      dq = qnorm(dq);
      const s = Math.hypot(dq[0], dq[1], dq[2]);
      const angle = 2 * Math.atan2(s, dq[3]);
      const k = s > 1e-12 ? angle / s / dt : 0;
      r.rb.setAngvel({ x: dq[0] * k, y: dq[1] * k, z: dq[2] * k }, true);
    }
  }
  teleport(position: Vec3, rotation?: Quat): void {
    const r = this.rec;
    if (!r) return;
    r.rb.setTranslation(rv(position), true);
    if (rotation) r.rb.setRotation(rq(rotation), true);
    r.hasPrev = false;
    this.s.queriesDirty = true;
  }
  wake(): void {
    this.rec?.rb.wakeUp();
  }
  setMass(kg: number): void {
    const r = this.rec;
    if (r) setTotalMass(r, kg);
  }
}

class JointHandleImpl implements JointHandle {
  constructor(
    private s: WorldState,
    readonly id: string,
  ) {}
  private get rec() {
    return this.s.joints.get(this.id);
  }
  get alive(): boolean {
    return !!this.rec;
  }
  get value(): number {
    return this.rec?.value ?? 0;
  }
  get speed(): number {
    return this.rec?.speed ?? 0;
  }
  get force(): number {
    return this.rec?.force ?? 0;
  }
  get broken(): boolean {
    return this.rec?.broken ?? false;
  }
  get bodyA(): string | null {
    return this.rec?.def.bodyA ?? null;
  }
  get bodyB(): string | null {
    return this.rec?.def.bodyB ?? null;
  }
}

/** The context of one component instance (created by the host). */
export class ComponentCtx implements ComponentContext {
  /** Updated by the host when the user edits the component. */
  spec: ComponentSpec;
  private watching = false;

  // -- CP: per-component access to the drive network
  readonly drive: DriveAccess;

  constructor(
    private readonly s: WorldState,
    private readonly host: ComponentHost,
    readonly ownerKind: 'body' | 'joint',
    readonly ownerId: string,
    spec: ComponentSpec,
  ) {
    this.spec = spec;
    this.drive = host.driveAccess(ownerKind, ownerId);
  }

  get componentId(): string {
    return this.spec.id;
  }
  get type(): string {
    return this.spec.type;
  }
  get params(): Readonly<ComponentParams> {
    return this.spec.params;
  }

  private fallback(key: string): ComponentValue | undefined {
    const f = componentDef(this.spec.type)?.fields.find((x) => x.key === key);
    return f?.default;
  }
  num(key: string): number {
    const v = this.spec.params[key];
    if (typeof v === 'number') return v;
    const d = this.fallback(key);
    return typeof d === 'number' ? d : 0;
  }
  bool(key: string): boolean {
    const v = this.spec.params[key];
    if (typeof v === 'boolean') return v;
    return this.fallback(key) === true;
  }
  str(key: string): string {
    const v = this.spec.params[key];
    if (typeof v === 'string') return v;
    const d = this.fallback(key);
    return typeof d === 'string' ? d : '';
  }
  vec3(key: string): Vec3 {
    const v = this.spec.params[key];
    if (Array.isArray(v) && v.length === 3 && typeof v[0] === 'number') return v as Vec3;
    const d = this.fallback(key);
    return Array.isArray(d) && d.length === 3 ? (d as Vec3) : [0, 0, 0];
  }
  curve(key: string): readonly (readonly number[])[] {
    const v = this.spec.params[key];
    if (Array.isArray(v) && v.length >= 2 && Array.isArray(v[0])) return v as number[][];
    const d = this.fallback(key);
    return Array.isArray(d) && Array.isArray(d[0]) ? (d as number[][]) : [];
  }
  curveAt(key: string, x: number): number {
    const pts = this.curve(key);
    if (!pts.length) return 0;
    if (x <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      if (x <= pts[i][0]) {
        const [x0, y0] = pts[i - 1];
        const [x1, y1] = pts[i];
        return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
      }
    }
    return pts[pts.length - 1][1];
  }

  get time(): number {
    return this.s.simTime;
  }
  get dt(): number {
    return fixedDt(this.s);
  }
  get step(): number {
    return this.s.stepCount;
  }

  get body(): BodyHandle | null {
    return this.ownerKind === 'body' ? this.host.bodyHandle(this.ownerId) : null;
  }
  get joint(): JointHandle | null {
    return this.ownerKind === 'joint' ? this.host.jointHandle(this.ownerId) : null;
  }
  bodyById(id: string): BodyHandle | null {
    return this.s.bodies.has(id) ? this.host.bodyHandle(id) : null;
  }
  jointById(id: string): JointHandle | null {
    return this.s.joints.has(id) ? this.host.jointHandle(id) : null;
  }
  path(id: string): PathCurve | null {
    return this.s.paths.get(id)?.curve ?? null;
  }

  raycast(origin: Vec3, dir: Vec3, maxDist: number, options?: RaycastOptions): RayHit | null {
    return castRay(this.s, origin, dir, maxDist, options);
  }
  contacts(bodyId: string = this.ownerId): ContactPoint[] {
    return contactsOf(this.s, bodyId);
  }
  watchContacts(on = true): void {
    if (on === this.watching) return;
    this.watching = on;
    watchContacts(this.s, on);
  }
  /** Undo `watchContacts` when the component goes away. */
  release(): void {
    if (this.watching) this.watchContacts(false);
    this.drive.releaseAll();
  }

  emit(name: string, data?: unknown): void {
    this.host.emit(this, name, data);
  }
  // -- ZN
  get zones(): ZoneSystem {
    return this.host.zones;
  }
  readonly input = {
    key: (code: string): boolean => this.s.keys.has(code),
    axis: (name: string): number => this.s.axes[name] ?? 0,
  };
  random(): number {
    return this.s.rng.next();
  }
  get rng(): Rng {
    return this.s.rng;
  }
  readonly state = {
    set: (values: ArrayLike<number>): void => this.host.setState(this, values, undefined, false),
    setJson: (value: unknown): void => this.host.setState(this, null, value, true),
  };
}

export { BodyHandleImpl, JointHandleImpl };
