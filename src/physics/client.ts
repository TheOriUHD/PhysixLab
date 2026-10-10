import { Emitter } from '../core/events';
import type { Vec3 } from '../core/math';
import type { SceneDocument } from '../model/types';
import {
  BODY_STRIDE,
  JOINT_STRIDE,
  PROTOCOL_VERSION,
  type BuiltInfo,
  type ComponentStateEntry,
  type EventConfig,
  type FromWorker,
  type RayHit,
  type RaycastOptions,
  type SimEvent,
  type SimOp,
  type SimStats,
  type SoftLayoutEntry,
  type ToWorker,
  type WorldSnapshot,
} from './protocol';

export interface TickOptions {
  dt: number;
  timeScale: number;
  running: boolean;
  stepCount?: number;
  keys: string[];
  /** Analog inputs by name; defaults to the client's own (`setAxis`). */
  axes?: Record<string, number>;
  wantContacts: boolean;
}

interface ClientEvents extends Record<string, unknown> {
  frame: undefined;
  event: SimEvent;
  /** A reply on a custom channel (protocol v2). */
  custom: { channel: string; data: unknown };
  error: string;
}

/**
 * Main-thread handle on the physics worker. Keeps the most recent frame (poses, joint
 * state, stats) and coalesces ticks so at most one is in flight.
 */
export class SimClient extends Emitter<ClientEvents> {
  private worker: Worker;
  private inflight = false;
  private inflightSince = 0;
  private pendingDt = 0;
  private pendingSteps = 0;
  private opQueue: SimOp[] = [];
  active = false;

  bodyIds: string[] = [];
  bodyIndex = new Map<string, number>();
  jointIds: string[] = [];
  jointIndex = new Map<string, number>();
  poses: Float32Array = new Float32Array(0);
  joints: Float32Array = new Float32Array(0);
  contacts: Float32Array = new Float32Array(0);
  /** Soft-body topology (set when it changes) and the latest particle positions. */
  softLayout: SoftLayoutEntry[] = [];
  softOffsets: number[] = [];
  softIndex = new Map<string, number>();
  softPositions: Float32Array = new Float32Array(0);
  /** Increments whenever the soft-body topology changes. */
  softLayoutNo = 0;
  stats: SimStats | null = null;
  info: BuiltInfo = { mass: {}, com: {} };
  /** Increments on every received frame. */
  frameNo = 0;
  // -- UI-B: diagnostics (worker status, round trip, apply time) --
  /** Protocol version the worker announced (null until it said ready). */
  workerProtocol: number | null = null;
  /** Message from the worker's last error, if any. */
  lastError: string | null = null;
  /** Milliseconds from sending the last tick to receiving its frame (includes the physics step). */
  roundTripMs = 0;
  /** Milliseconds the main thread spent unpacking the last frame. */
  applyMs = 0;
  /** Increments whenever bodyIds / jointIds change. */
  layoutNo = 0;
  broken = new Set<string>();
  /** Analog inputs by name, sent with every tick (`setAxis`). */
  readonly axes: Record<string, number> = {};
  /** The latest state each component published, by component id (`stateOf`). */
  readonly componentState = new Map<string, ComponentStateEntry>();
  private nextRequest = 1;
  private rayRequests = new Map<number, (hit: RayHit | null) => void>();
  private snapshotRequests = new Map<number, { resolve: (s: WorldSnapshot) => void; reject: (e: Error) => void }>();

  constructor() {
    super();
    this.worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onMessage(e.data);
    this.worker.onerror = (e) => {
      this.lastError = e.message; // -- UI-B: diagnostics --
      this.emit('error', e.message);
    };
  }

  private send(msg: ToWorker): void {
    this.worker.postMessage(msg);
  }

  private onMessage(m: FromWorker): void {
    switch (m.type) {
      case 'built':
        this.info = m.info;
        break;
      case 'custom':
        this.emit('custom', { channel: m.channel, data: m.data });
        break;
      case 'frame': {
        const t0 = performance.now(); // -- UI-B: diagnostics --
        this.roundTripMs = t0 - this.inflightSince;
        this.inflight = false;
        if (!this.active) return;
        if (m.bodyIds) {
          this.bodyIds = m.bodyIds;
          this.bodyIndex = new Map(m.bodyIds.map((id, i) => [id, i]));
          this.layoutNo++;
        }
        if (m.jointIds) {
          this.jointIds = m.jointIds;
          this.jointIndex = new Map(m.jointIds.map((id, i) => [id, i]));
          this.layoutNo++;
        }
        if (m.info) this.info = m.info;
        if (m.softLayout) {
          this.softLayout = m.softLayout;
          this.softIndex = new Map(m.softLayout.map((e, i) => [e.id, i]));
          let o = 0;
          this.softOffsets = m.softLayout.map((e) => {
            const at = o;
            o += e.count;
            return at;
          });
          this.softLayoutNo++;
        }
        this.softPositions = m.softPositions ?? new Float32Array(0);
        this.poses = m.poses;
        this.joints = m.joints;
        this.contacts = m.contacts ?? new Float32Array(0);
        this.stats = m.stats;
        for (const id of m.componentStateRemoved ?? []) this.componentState.delete(id);
        if (m.componentState) for (const [id, e] of Object.entries(m.componentState)) this.componentState.set(id, e);
        for (const r of m.raycasts ?? []) {
          this.rayRequests.get(r.id)?.(r.hit);
          this.rayRequests.delete(r.id);
        }
        for (const r of m.snapshots ?? []) {
          this.snapshotRequests.get(r.id)?.resolve(r.snapshot);
          this.snapshotRequests.delete(r.id);
        }
        this.frameNo++;
        this.applyMs = performance.now() - t0; // -- UI-B: diagnostics --
        for (const ev of m.events) {
          if (ev.kind === 'jointBroken') this.broken.add(ev.id);
          this.emit('event', ev);
        }
        this.emit('frame', undefined);
        break;
      }
      case 'error':
        this.lastError = m.message; // -- UI-B: diagnostics --
        this.inflight = false;
        this.emit('error', m.message);
        break;
      case 'ready':
        this.workerProtocol = m.protocol; // -- UI-B: diagnostics --
        if (m.protocol !== PROTOCOL_VERSION) {
          this.emit('error', `physics worker speaks protocol v${m.protocol}, this page expects v${PROTOCOL_VERSION}`);
        }
        break;
    }
  }

  /** Create a fresh simulated world from the document. */
  build(doc: SceneDocument): void {
    this.active = true;
    this.inflight = false;
    this.pendingDt = 0;
    this.pendingSteps = 0;
    this.opQueue = [];
    this.bodyIds = [];
    this.bodyIndex.clear();
    this.jointIds = [];
    this.jointIndex.clear();
    this.broken.clear();
    this.componentState.clear();
    this.cancelRequests();
    this.softLayout = [];
    this.softOffsets = [];
    this.softIndex.clear();
    this.softPositions = new Float32Array(0);
    this.softLayoutNo++;
    this.stats = null;
    this.frameNo = 0;
    this.layoutNo++;
    this.send({ type: 'build', doc });
    if (this.loadWatch) this.opQueue.push({ op: 'watchLoads', on: true }); // the new world starts without it
  }

  /** Discard the simulated world (back to edit mode). */
  dispose(): void {
    this.active = false;
    this.opQueue = [];
    this.componentState.clear();
    this.cancelRequests();
    this.send({ type: 'dispose' });
    this.poses = new Float32Array(0);
    this.softLayout = [];
    this.softPositions = new Float32Array(0);
    this.softLayoutNo++;
  }

  destroy(): void {
    this.cancelRequests();
    this.worker.terminate();
  }

  /** Pending ray casts resolve to "no hit"; pending snapshots are rejected (the simulation they were asked of is gone). */
  private cancelRequests(): void {
    for (const resolve of this.rayRequests.values()) resolve(null);
    this.rayRequests.clear();
    for (const { reject } of this.snapshotRequests.values())
      reject(new Error('The simulation was reset before the snapshot arrived.'));
    this.snapshotRequests.clear();
  }

  op(op: SimOp): void {
    if (!this.active) return;
    this.opQueue.push(op);
  }

  // ---- protocol v2 --------------------------------------------------------------------------

  /** Set an analog input (usually −1 … 1); components read it as `ctx.input.axis(name)`. `0` removes it. */
  setAxis(name: string, value: number): void {
    if (value === 0) delete this.axes[name];
    else this.axes[name] = value;
  }

  /** The latest numbers a component published (`ctx.state.set`), or null. */
  stateOf(componentId: string): Float32Array | null {
    return this.componentState.get(componentId)?.values ?? null;
  }

  /** The latest JSON a component published (`ctx.state.setJson`), or undefined. */
  jsonOf(componentId: string): unknown {
    return this.componentState.get(componentId)?.json;
  }

  /** JT-10: keep joint load estimates running (otherwise only breakable joints are tracked). */
  watchLoads(on: boolean): void {
    if (on === this.loadWatch) return;
    this.loadWatch = on;
    this.op({ op: 'watchLoads', on });
  }
  private loadWatch = false;

  setSeed(seed: number): void {
    this.op({ op: 'setSeed', seed });
  }

  /** Switch contact events on / off or tune them (`EventConfig`). */
  configureEvents(config: Partial<EventConfig>): void {
    this.op({ op: 'events', config });
  }

  /**
   * Cast a ray in the simulated world. Resolves with the nearest hit (or null) once the worker has answered — a
   * frame or two later — and with null if the simulation is reset first.
   */
  raycast(origin: Vec3, dir: Vec3, maxDist: number, options?: RaycastOptions): Promise<RayHit | null> {
    if (!this.active) return Promise.resolve(null);
    const id = this.nextRequest++;
    return new Promise((resolve) => {
      this.rayRequests.set(id, resolve);
      this.op({ op: 'raycast', id, origin, dir, maxDist, options });
    });
  }

  /**
   * Capture the complete simulation state (see `WorldSnapshot`). Resolves a frame or two later; rejects when there is
   * no simulation, or when it is reset before the answer arrives.
   */
  snapshot(): Promise<WorldSnapshot> {
    if (!this.active) return Promise.reject(new Error('There is no running simulation to take a snapshot of.'));
    const id = this.nextRequest++;
    return new Promise((resolve, reject) => {
      this.snapshotRequests.set(id, { resolve, reject });
      this.op({ op: 'snapshot', id });
    });
  }

  /** Bring a snapshot back; the next frame announces the restored set of bodies. */
  restore(snapshot: WorldSnapshot): void {
    this.op({ op: 'restore', snapshot });
  }

  /** Send a message to a handler registered with `registerCustomChannel`; replies arrive as the `'custom'` event. */
  sendCustom(channel: string, data: unknown): void {
    if (this.active) this.send({ type: 'custom', channel, data });
  }

  /** Drive the simulation. Safe to call every animation frame. */
  tick(o: TickOptions): void {
    if (!this.active) return;
    this.pendingDt += o.dt;
    this.pendingSteps += o.stepCount ?? 0;
    if (this.inflight && performance.now() - this.inflightSince < 1000) return;
    if (this.opQueue.length) {
      this.send({ type: 'ops', ops: this.opQueue });
      this.opQueue = [];
    }
    this.inflight = true;
    this.inflightSince = performance.now();
    this.send({
      type: 'tick',
      dt: this.pendingDt,
      timeScale: o.timeScale,
      running: o.running,
      stepCount: this.pendingSteps,
      keys: o.keys,
      axes: o.axes ?? this.axes,
      wantContacts: o.wantContacts,
    });
    this.pendingDt = 0;
    this.pendingSteps = 0;
  }

  // ---- frame readers -----------------------------------------------------------------------

  poseOf(id: string): Float32Array | null {
    const i = this.bodyIndex.get(id);
    if (i === undefined || (i + 1) * BODY_STRIDE > this.poses.length) return null;
    return this.poses.subarray(i * BODY_STRIDE, (i + 1) * BODY_STRIDE);
  }

  /** Particle positions of one soft entity (a view into the frame buffer), or null. */
  softOf(id: string): Float32Array | null {
    const i = this.softIndex.get(id);
    if (i === undefined) return null;
    const o = this.softOffsets[i] * 3;
    const end = o + this.softLayout[i].count * 3;
    return end <= this.softPositions.length ? this.softPositions.subarray(o, end) : null;
  }

  jointOf(id: string): Float32Array | null {
    const i = this.jointIndex.get(id);
    if (i === undefined || (i + 1) * JOINT_STRIDE > this.joints.length) return null;
    return this.joints.subarray(i * JOINT_STRIDE, (i + 1) * JOINT_STRIDE);
  }
}
