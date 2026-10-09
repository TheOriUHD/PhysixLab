import { Emitter } from '../core/events';
import type { SceneDocument } from '../model/types';
import {
  BODY_STRIDE,
  JOINT_STRIDE,
  type BuiltInfo,
  type FromWorker,
  type SimEvent,
  type SimOp,
  type SimStats,
  type SoftLayoutEntry,
  type ToWorker,
} from './protocol';

export interface TickOptions {
  dt: number;
  timeScale: number;
  running: boolean;
  stepCount?: number;
  keys: string[];
  wantContacts: boolean;
}

interface ClientEvents extends Record<string, unknown> {
  frame: undefined;
  event: SimEvent;
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
  /** Increments whenever bodyIds / jointIds change. */
  layoutNo = 0;
  broken = new Set<string>();

  constructor() {
    super();
    this.worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onMessage(e.data);
    this.worker.onerror = (e) => this.emit('error', e.message);
  }

  private send(msg: ToWorker): void {
    this.worker.postMessage(msg);
  }

  private onMessage(m: FromWorker): void {
    switch (m.type) {
      case 'built':
        this.info = m.info;
        break;
      case 'frame': {
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
        this.frameNo++;
        for (const ev of m.events) {
          if (ev.kind === 'jointBroken') this.broken.add(ev.id);
          this.emit('event', ev);
        }
        this.emit('frame', undefined);
        break;
      }
      case 'error':
        this.inflight = false;
        this.emit('error', m.message);
        break;
      case 'ready':
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
    this.softLayout = [];
    this.softOffsets = [];
    this.softIndex.clear();
    this.softPositions = new Float32Array(0);
    this.softLayoutNo++;
    this.stats = null;
    this.frameNo = 0;
    this.layoutNo++;
    this.send({ type: 'build', doc });
  }

  /** Discard the simulated world (back to edit mode). */
  dispose(): void {
    this.active = false;
    this.opQueue = [];
    this.send({ type: 'dispose' });
    this.poses = new Float32Array(0);
    this.softLayout = [];
    this.softPositions = new Float32Array(0);
    this.softLayoutNo++;
  }

  destroy(): void {
    this.worker.terminate();
  }

  op(op: SimOp): void {
    if (!this.active) return;
    this.opQueue.push(op);
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
