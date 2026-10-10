/**
 * The joint tool (JT-21): where a click lands (the exact surface point, or a snap to the body centre, a face centre,
 * an edge midpoint or a corner), the live snap marker and rubber band, the options read from the preferences, chain
 * mode (every click continues from the body just joined, the whole chain is ONE undo step) and "Connect all" for a
 * selection. The pure geometry lives in `src/model/jointDefaults.ts`; this file is the glue to the app and the scene.
 */
import { Mesh, MeshBasicMaterial, SphereGeometry, Vector3 } from 'three';
import type { Vec3 } from '../core/math';
import {
  closestBoxPoints,
  connectPairs,
  findSnap,
  isAxisChoice,
  isConnectMode,
  limitFromPreset,
  pickJointAxis,
  snapCandidates,
  SNAP_LABELS,
  worldBox,
  type AxisChoice,
  type ConnectMode,
  type EndInfo,
  type SnapHit,
  type SnapKind,
} from '../model/jointDefaults';
import { hasIndependentAnchors } from '../model/jointParams';
import { shapeDef } from '../model/shapeRegistry';
import { JOINT_TYPE_LABELS } from '../model/factory';
import type { BodyEntity, JointEntity, JointType } from '../model/types';
import type { App } from './app';
import type { Editor } from './editor';
import type { SceneStore } from '../model/store';
import type { Prefs } from './prefs';

// ---- options ------------------------------------------------------------------------------------------

export interface JointOptions {
  type: JointType;
  axis: AxisChoice;
  limit: string;
  snap: boolean;
  collide: boolean;
  chain: boolean;
  connect: ConnectMode;
}

/** The joint-tool preferences with anything unknown (a stale saved value) repaired to its default. */
export function jointOptions(p: Prefs): JointOptions {
  return {
    type: p.jointType,
    axis: isAxisChoice(p.jointAxis) ? p.jointAxis : 'auto',
    limit: typeof p.jointLimit === 'string' ? p.jointLimit : 'off',
    snap: p.jointSnap !== false,
    collide: p.jointCollide === true,
    chain: p.jointChain === true,
    connect: isConnectMode(p.jointConnect) ? p.jointConnect : 'chain',
  };
}

/** Pixel radius within which the cursor snaps to a candidate. */
export const SNAP_PIXELS = 14;

/** The fixed world axis of an axis choice (x / y / z), else undefined. */
const fixedAxis = (c: AxisChoice): Vec3 | undefined =>
  c === 'x' ? [1, 0, 0] : c === 'y' ? [0, 1, 0] : c === 'z' ? [0, 0, 1] : undefined;

// ---- connect all --------------------------------------------------------------------------------------

export interface ConnectResult {
  joints: JointEntity[];
  /** The all-pairs list was cut at the cap. */
  truncated: boolean;
  /** Pairs left out because both bodies are static. */
  skipped: number;
}

/**
 * Join `ids` (bodies, in the given order) with joints of `opts.type` as ONE undo step. Anchors sit at the bodies'
 * centres for the types with two independent anchors (springs, ropes, gears …), and at the closest points of the
 * bodies' bounding boxes for the others (the middle of the contact for bodies that touch).
 */
export function connectBodies(editor: Editor, ids: readonly string[], opts: JointOptions): ConnectResult {
  const store = editor.store;
  const bodies = [...new Set(ids)].map((id) => store.body(id)).filter((b): b is BodyEntity => !!b);
  const { pairs, truncated } = connectPairs(bodies.length, opts.connect);
  const infoOf = (b: BodyEntity): EndInfo => {
    const pose = editor.sim.poseOf(b.id);
    const position = pose?.position ?? b.position;
    return { body: b.id, point: position, position, rotation: pose?.rotation ?? b.rotation, shape: b.shape };
  };
  const over: Partial<JointEntity> = { collideConnected: opts.collide };
  const limit = limitFromPreset(opts.type, opts.limit);
  if (limit) over.limit = limit;
  const axis = fixedAxis(opts.axis);
  const joints: JointEntity[] = [];
  let skipped = 0;
  const label = `Connect ${bodies.length} bodies`;
  store.transact(label, () => {
    for (const [i, j] of pairs) {
      const A = bodies[i];
      const B = bodies[j];
      if (A.bodyType === 'static' && B.bodyType === 'static') {
        skipped++;
        continue;
      }
      const ia = infoOf(A);
      const ib = infoOf(B);
      let pa = ia.position;
      let pb = ib.position;
      if (!hasIndependentAnchors(opts.type)) [pa, pb] = closestBoxPoints(worldBox(ia), worldBox(ib));
      const joint = editor.addJoint(opts.type, { body: A.id, point: pa }, { body: B.id, point: pb }, axis, over);
      if (joint) joints.push(joint);
    }
  });
  return { joints, truncated, skipped };
}

/** "Connect all" for the current selection with the options-bar settings: toast, select the new joints. Returns the count. */
export function connectSelected(app: App): number {
  const ids = app.store.selection.filter((id) => !!app.store.body(id));
  if (ids.length < 2) {
    app.toast('Select two or more bodies first, then use Connect all', 'warn');
    return 0;
  }
  const opts = jointOptions(app.prefs.value);
  const r = connectBodies(app.editor, ids, opts);
  if (!r.joints.length) {
    app.toast('Nothing to connect — two static bodies cannot be joined', 'warn');
    return 0;
  }
  app.store.setSelection(r.joints.map((j) => j.id));
  const n = r.joints.length;
  let msg = `${n} ${JOINT_TYPE_LABELS[opts.type].toLowerCase()} joint${n === 1 ? '' : 's'} added between ${ids.length} bodies`;
  if (r.truncated) msg += ' (capped at 40 — use Chain or Star for more)';
  app.toast(msg, r.truncated ? 'warn' : 'success');
  return n;
}

// ---- the tool -----------------------------------------------------------------------------------------

/** Where the pointer is for the joint tool: a body (with the exact surface point) or the ground. */
interface Resolved {
  body: string | null;
  point: Vector3;
  normal: Vector3 | null;
  snap: SnapKind | null;
}

const COLOR_SURFACE = 0x3ddcff;
const COLOR_SNAP = 0x5be3a1;
const COLOR_GROUND = 0x98a5b9;

/**
 * Folds the joints of one chain into a single undo step: each joint is added as an ordinary step, then merged into the
 * step below it, as long as nothing else was recorded in between (an undo, another edit) — then the chain simply
 * restarts and the earlier joints stay a separate step.
 */
export class ChainTracker {
  count = 0;
  private depth = 0;

  reset(): void {
    this.count = 0;
  }

  /** Call right after a chain joint was added to the store. */
  record(store: SceneStore): void {
    if (this.count > 0 && store.undoDepth === this.depth + 1) {
      store.foldLastUndo(`Chain of ${this.count + 1} joints`);
    }
    this.depth = store.undoDepth;
    this.count++;
  }
}

const tools = new WeakMap<App, JointTool>();

/** The joint tool of an app (created on first use). */
export function jointToolOf(app: App): JointTool {
  let t = tools.get(app);
  if (!t) {
    t = new JointTool(app);
    tools.set(app, t);
  }
  return t;
}

export class JointTool {
  private readonly marker: Mesh;
  private readonly halo: Mesh;
  private readonly cur: Resolved = { body: null, point: new Vector3(), normal: null, snap: null };
  private readonly curNormal = new Vector3();
  private soft = false;
  private readonly snapOut: SnapHit = { kind: 'center', world: [0, 0, 0], normal: null };
  private readonly point: Vec3 = [0, 0, 0];
  private readonly offPrefs: () => void;
  // draft and chain
  private firstNormal: Vec3 | null = null;
  private readonly chain = new ChainTracker();
  private lastPress = 0;
  private labelShown = false;

  constructor(private app: App) {
    const mat = new MeshBasicMaterial({ color: COLOR_SURFACE, depthTest: false, transparent: true, toneMapped: false });
    this.marker = new Mesh(new SphereGeometry(0.5, 16, 12), mat);
    const haloMat = new MeshBasicMaterial({
      color: COLOR_SURFACE,
      depthTest: false,
      transparent: true,
      opacity: 0.28,
      toneMapped: false,
    });
    this.halo = new Mesh(this.marker.geometry, haloMat);
    this.halo.scale.setScalar(2.2);
    this.marker.add(this.halo);
    for (const m of [this.marker, this.halo]) {
      m.renderOrder = 998;
      m.frustumCulled = false;
      m.raycast = () => undefined; // never pickable
    }
    this.marker.visible = false;
    app.viewport.helpers.add(this.marker);
    this.offPrefs = app.prefs.on('change', (keys) => {
      if (keys.includes('tool') && app.prefs.value.tool !== 'joint') this.hideMarker();
      if (keys.includes('tool') || keys.includes('jointType')) this.chain.reset();
    });
  }

  dispose(): void {
    this.offPrefs();
    this.app.viewport.helpers.remove(this.marker);
    this.marker.geometry.dispose();
    (this.marker.material as MeshBasicMaterial).dispose();
    (this.halo.material as MeshBasicMaterial).dispose();
    this.app.labels.remove('joint-snap');
  }

  // ---- pointer → anchor ----------------------------------------------------------------------

  /** Metres per screen pixel at a world point (for the pixel snap radius and the marker size). */
  private metresPerPixel(at: Vector3): number {
    const cam = this.app.camera;
    const h = Math.max(1, this.app.viewport.dom.clientHeight);
    return (2 * cam.position.distanceTo(at) * Math.tan((cam.fov * Math.PI) / 360)) / h;
  }

  /**
   * Resolve the pointer into `this.cur` (reused, so it is valid until the next call): the exact picked surface
   * point, replaced by a snap candidate within `SNAP_PIXELS` when snapping is on. False when nothing is under the pointer.
   */
  private resolve(e: { clientX: number; clientY: number }): boolean {
    const app = this.app;
    this.soft = false;
    const hit = app.pickEntity(e, { joints: false });
    const cur = this.cur;
    if (hit && app.store.soft(hit.entityId)) {
      this.soft = true;
      return false;
    }
    const body = hit ? app.store.body(hit.entityId) : undefined;
    if (hit && body) {
      cur.body = body.id;
      cur.point.copy(hit.point);
      cur.normal = hit.normal ? this.curNormal.copy(hit.normal).normalize() : null;
      cur.snap = null;
      if (jointOptions(app.prefs.value).snap) {
        const pose = app.sim.poseOf(body.id);
        if (pose) {
          const tol = SNAP_PIXELS * this.metresPerPixel(hit.point);
          this.point[0] = hit.point.x;
          this.point[1] = hit.point.y;
          this.point[2] = hit.point.z;
          const s = findSnap(snapCandidates(body.shape), pose.position, pose.rotation, this.point, tol, this.snapOut);
          if (s) {
            cur.point.set(s.world[0], s.world[1], s.world[2]);
            cur.snap = s.kind;
            if (s.normal) cur.normal = this.curNormal.set(s.normal[0], s.normal[1], s.normal[2]);
          }
        }
      }
      return true;
    }
    const ground = app.picker.groundPoint(e, 0);
    if (ground && ground.distanceTo(app.camera.position) < 400) {
      cur.body = null;
      cur.point.copy(ground);
      cur.normal = null;
      cur.snap = null;
      return true;
    }
    return false;
  }

  /** Pointer move with the joint tool active: the snap marker, its label and the rubber band from the first anchor. */
  hover(e: { clientX: number; clientY: number }): void {
    const app = this.app;
    if (!this.resolve(e)) {
      app.hoverId = null;
      this.hideMarker();
      return;
    }
    const cur = this.cur;
    app.hoverId = cur.body;
    this.showMarker(cur);
    if (app.jointDraft) app.setMeasureLine(app.jointDraft.point, cur.point);
  }

  private showMarker(r: Resolved): void {
    const m = this.marker;
    m.position.copy(r.point);
    m.scale.setScalar(this.metresPerPixel(r.point) * (r.snap ? 6 : 4));
    const color = r.snap ? COLOR_SNAP : r.body ? COLOR_SURFACE : COLOR_GROUND;
    (m.material as MeshBasicMaterial).color.setHex(color);
    (this.halo.material as MeshBasicMaterial).color.setHex(color);
    m.visible = true;
    if (r.snap) {
      this.app.labels.set('joint-snap', r.point, SNAP_LABELS[r.snap], 'accent joint-snap');
      this.labelShown = true;
    } else this.clearLabel();
  }

  private clearLabel(): void {
    if (!this.labelShown) return;
    this.app.labels.remove('joint-snap');
    this.labelShown = false;
  }

  hideMarker(): void {
    this.marker.visible = false;
    this.clearLabel();
  }

  // ---- click, chain --------------------------------------------------------------------------

  /** Pointer press with the joint tool active. */
  press(e: PointerEvent): void {
    const app = this.app;
    const opts = jointOptions(app.prefs.value);
    const type = opts.type;
    if (!this.resolve(e)) {
      if (this.soft) app.toast('Joints can’t attach to soft bodies — they can only be pinned in space', 'warn');
      return;
    }
    const end = this.cur;
    const now = performance.now();
    const quick = now - this.lastPress < 450;
    this.lastPress = now;
    const name = JOINT_TYPE_LABELS[type];

    if (!app.jointDraft) {
      app.jointDraft = { body: end.body, point: end.point.clone() };
      this.firstNormal = end.normal ? [end.normal.x, end.normal.y, end.normal.z] : null;
      this.chain.reset();
      app.effects.ping(end.point, 0xffb347);
      app.setHint(
        `<b>${name}</b> — now click the second body, or empty ground to attach to the world · <kbd>Esc</kbd> cancels`,
      );
      return;
    }
    const a = app.jointDraft;
    if (a.body && a.body === end.body) {
      // The second click of a double-click that ends a chain lands on the body just joined: not an error.
      if (!(opts.chain && quick)) app.toast('Pick two different bodies', 'warn');
      return;
    }
    if (!a.body && !end.body) {
      app.toast('At least one end must be a body', 'warn');
      return;
    }
    const axial = (id: string | null): boolean => {
      const b = id ? app.store.body(id) : undefined;
      return !!b && !!shapeDef(b.shape.type).axial;
    };
    const normal = this.firstNormal ?? (end.normal ? ([end.normal.x, end.normal.y, end.normal.z] as Vec3) : null);
    const axis = pickJointAxis({ type, choice: opts.axis, normal, axial: axial(a.body ?? end.body) });
    const over: Partial<JointEntity> = { collideConnected: opts.collide };
    const limit = limitFromPreset(type, opts.limit);
    if (limit) over.limit = limit;
    const j = app.editor.addJoint(
      type,
      { body: a.body, point: [a.point.x, a.point.y, a.point.z] },
      { body: end.body, point: [end.point.x, end.point.y, end.point.z] },
      axis,
      over,
    );
    if (!j) {
      app.cancelJointDraft();
      app.updateToolHint();
      return;
    }
    app.effects.ping(end.point, 0x5be3a1);
    this.chain.record(app.store);

    if (opts.chain && end.body) {
      app.jointDraft = { body: end.body, point: end.point.clone() };
      this.firstNormal = end.normal ? [end.normal.x, end.normal.y, end.normal.z] : null;
      app.setMeasureLine(end.point, end.point);
      app.setHint(
        `<b>${name}</b> chain: ${this.chain.count} joint${this.chain.count === 1 ? '' : 's'} — click the next body · <kbd>Enter</kbd> or double-click to finish · <kbd>Esc</kbd> stops`,
      );
      return;
    }
    const count = this.chain.count;
    this.chain.reset();
    app.cancelJointDraft();
    if (!e.shiftKey) app.setTool('select');
    app.toast(
      count > 1
        ? `Chain of ${count} joints added — select one to edit limits, motors and springs`
        : `${j.name} added — select it to edit limits, motors and springs`,
      'success',
    );
    app.updateToolHint();
  }

  /** Enter / double-click while drawing: end the chain (or a lone first click) and go back to the select tool. */
  finish(): boolean {
    const app = this.app;
    if (!app.jointDraft) return false;
    const count = this.chain.count;
    this.chain.reset();
    app.cancelJointDraft();
    if (count > 0) {
      app.setTool('select');
      app.toast(`Chain of ${count} joint${count === 1 ? '' : 's'} added`, 'success');
    }
    app.updateToolHint();
    return true;
  }
}
