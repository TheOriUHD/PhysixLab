/**
 * SimController — owns the edit / paused / running state machine and keeps the live
 * physics worker consistent with edits made to the scene document while it is running.
 *
 *   edit    → no simulated world exists; the viewport shows the document.
 *   running → a worker world exists and is stepping in real time.
 *   paused  → the world exists but is frozen; it can be inspected, edited and single-stepped.
 *
 * Edits fall into two classes: *structure/properties* (add, delete, material, motor …) apply to
 * the document and the live world alike; *poses* (moving a body while paused) affect only the
 * live world, so Reset always returns to the layout the user built.
 */
import { pruneAssets } from '../model/assets';
import { Emitter } from '../core/events';
import type { Quat, Vec3 } from '../core/math';
import type { SceneChange, SceneStore } from '../model/store';
import type { BodyEntity, SceneDocument } from '../model/types';
import { isBody, isJoint, isPath, isSoft } from '../model/types';
import { SimClient } from '../physics/client';
import { B, BODY_STRIDE } from '../physics/protocol';

export type SimMode = 'edit' | 'paused' | 'running';

interface Events extends Record<string, unknown> {
  mode: SimMode;
  layout: undefined;
  broken: { id: string; force: number };
}

/** Keys of an entity that never matter to the live world. */
const EDITOR_ONLY = new Set([
  'name',
  'locked',
  'hidden',
  'tags',
  'layer',
  'parent',
  'meshId',
  'skin',
  'colorTag',
  'solo',
  'soloHid',
]);

export class SimController extends Emitter<Events> {
  readonly client = new SimClient();
  mode: SimMode = 'edit';
  timeScale = 1;
  /** Bodies that exist only in the running simulation (projectiles, spawned debris). */
  readonly ephemeral = new Map<string, BodyEntity>();
  readonly keys = new Set<string>();
  wantContacts = false;
  /** The document the running world was built from (null while editing). */
  builtDoc: SceneDocument | null = null;
  private pendingSteps = 0;
  private lastTick = performance.now();

  constructor(private store: SceneStore) {
    super();
    store.on('change', (c) => this.onStoreChange(c));
    this.client.on('event', (ev) => {
      if (ev.kind === 'jointBroken') this.emit('broken', { id: ev.id, force: ev.force });
    });
  }

  get active(): boolean {
    return this.mode !== 'edit';
  }

  // ---- state machine -----------------------------------------------------------------------

  play(): void {
    if (this.mode === 'edit') this.build();
    this.setMode('running');
  }

  pause(): void {
    if (this.mode === 'running') this.setMode('paused');
  }

  toggle(): void {
    if (this.mode === 'running') this.pause();
    else this.play();
  }

  /** Advance one fixed step (starts a paused simulation if none exists). */
  step(count = 1): void {
    if (this.mode === 'edit') {
      this.build();
      this.setMode('paused');
    }
    if (this.mode === 'running') this.setMode('paused');
    this.pendingSteps += count;
  }

  reset(): void {
    if (this.mode === 'edit') return;
    this.client.dispose();
    this.ephemeral.clear();
    this.setMode('edit');
    this.emit('layout', undefined);
  }

  private build(): void {
    this.ephemeral.clear();
    // Only assets something references go to the worker (they can be megabytes).
    this.builtDoc = pruneAssets(this.store.toDocument()); // -- TM: replays start from this scene --
    this.client.build(this.builtDoc);
    this.emit('layout', undefined);
  }

  private setMode(m: SimMode): void {
    if (m === this.mode) return;
    this.mode = m;
    this.lastTick = performance.now();
    this.emit('mode', m);
  }

  // ---- per-frame ---------------------------------------------------------------------------

  tick(): void {
    const now = performance.now();
    const dt = Math.min(0.25, (now - this.lastTick) / 1000);
    this.lastTick = now;
    if (!this.client.active) return;
    const steps = this.pendingSteps;
    this.pendingSteps = 0;
    this.client.tick({
      dt,
      timeScale: this.timeScale,
      running: this.mode === 'running',
      stepCount: steps,
      keys: [...this.keys],
      axes: this.client.axes,
      wantContacts: this.wantContacts,
    });
  }

  /** Set an analog input for components (`ctx.input.axis(name)`); 0 clears it. */
  setAxis(name: string, value: number): void {
    this.client.setAxis(name, value);
  }

  // ---- pose access (live frame when simulating, document otherwise) -------------------------

  poseOf(id: string): { position: Vec3; rotation: Quat } | null {
    if (this.client.active) {
      const p = this.client.poseOf(id);
      if (p) {
        return {
          position: [p[B.px], p[B.py], p[B.pz]],
          rotation: [p[B.qx], p[B.qy], p[B.qz], p[B.qw]],
        };
      }
    }
    const e = this.store.body(id) ?? this.store.soft(id) ?? this.ephemeral.get(id);
    return e ? { position: e.position, rotation: e.rotation } : null;
  }

  velocityOf(id: string): { linear: Vec3; angular: Vec3; force: Vec3; ke: number; state: number } | null {
    const p = this.client.active ? this.client.poseOf(id) : null;
    if (!p) return null;
    return {
      linear: [p[B.vx], p[B.vy], p[B.vz]],
      angular: [p[B.wx], p[B.wy], p[B.wz]],
      force: [p[B.fx], p[B.fy], p[B.fz]],
      ke: p[B.ke],
      state: p[B.state],
    };
  }

  /** Move a body in the live world only (document untouched). */
  teleport(id: string, position: Vec3, rotation: Quat): void {
    this.client.op({ op: 'teleport', id, position, rotation });
  }

  spawn(def: BodyEntity): void {
    if (!this.client.active) return;
    this.ephemeral.set(def.id, def);
    this.client.op({ op: 'addBody', body: def, ephemeral: true });
    this.emit('layout', undefined);
  }

  get bodyCountInSim(): number {
    return this.client.poses.length / BODY_STRIDE;
  }

  // ---- document → live world sync ----------------------------------------------------------

  private onStoreChange(c: SceneChange): void {
    if (!this.client.active) return;
    switch (c.type) {
      case 'reset':
        // Wholesale change (load): drop the simulation.
        this.client.dispose();
        this.ephemeral.clear();
        this.setMode('edit');
        break;
      case 'add':
        for (const id of c.ids) {
          const e = this.store.get(id);
          if (isBody(e)) this.client.op({ op: 'addBody', body: e });
        }
        for (const id of c.ids) {
          const e = this.store.get(id);
          if (isJoint(e)) this.client.op({ op: 'addJoint', joint: e });
          else if (isSoft(e)) this.client.op({ op: 'addSoft', soft: e });
          else if (isPath(e)) this.client.op({ op: 'setPath', path: e });
        }
        break;
      case 'remove':
        this.client.op({ op: 'remove', ids: c.ids });
        break;
      case 'update': {
        const relevant = [...c.keys].some((k) => !EDITOR_ONLY.has(k));
        if (!relevant) return;
        for (const id of c.ids) {
          const e = this.store.get(id);
          if (isBody(e)) {
            // Pure pose edits are not applied to a live world (Reset restores them).
            const onlyPose = [...c.keys].every((k) => EDITOR_ONLY.has(k) || k === 'position' || k === 'rotation');
            if (!onlyPose) this.client.op({ op: 'updateBody', body: e });
          } else if (isPath(e)) this.client.op({ op: 'setPath', path: e });
          else if (isJoint(e)) this.client.op({ op: 'updateJoint', joint: e });
          else if (isSoft(e)) {
            const onlyPose = [...c.keys].every((k) => EDITOR_ONLY.has(k) || k === 'position' || k === 'rotation');
            if (!onlyPose) this.client.op({ op: 'updateSoft', soft: e });
          }
        }
        break;
      }
      case 'settings':
        this.client.op({ op: 'settings', settings: this.store.settings });
        break;
      case 'assets':
        break; // the physics worker does not use assets yet; it gets the referenced ones when it is built
    }
  }

  dispose(): void {
    this.client.destroy();
  }
}
