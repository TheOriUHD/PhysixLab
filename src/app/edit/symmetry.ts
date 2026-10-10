/**
 * ED-11: symmetry mode. While it is on, an edit of an entity is repeated on its mirror-image partner about a
 * world plane (X, Y or Z, through the origin or at an offset), inside the SAME undo step: a listener on the store's
 * 'change' event applies the mirrored patch through `store.amend`, so one Ctrl+Z reverts both halves.
 *
 * Partners are tracked in a map keyed by entity id. They come from three places: `findMirrorPairs` matching poses
 * when the mode is switched on (or the plane changes, or a scene is loaded), the pair made by a mirror copy, and
 * the partner this listener creates when something new is added. The pairs are NOT saved with the scene — they are
 * re-derived whenever the mode is switched on, which only needs the document to still hold mirror-image poses.
 *
 * What is mirrored (per kind): pose, and every field the inspector edits (size / shape, parts, material, mass, joint
 * limits and motors …). Names, locks, visibility and group membership are not. Edits to both halves in one go (a
 * select-all move) are applied as made; the next edit of one half re-syncs the other. Locked partners are left alone.
 */
import { Emitter } from '../../core/events';
import { cloneComponents } from '../../model/componentRegistry';
import {
  AXIS_NAMES,
  axisPlane,
  findMirrorPairs,
  mirrorComponents,
  mirrorCopy,
  mirrorFields,
  mirrorJointFields,
  mirrorMeshAsset,
  onPlane,
  type Axis,
  type MirrorOptions,
  type MirrorPair,
  type MirrorPlane,
} from '../../model/edit/mirror';
import { uid } from '../../model/factory';
import type { SceneChange, SceneStore } from '../../model/store';
import type { Entity, JointEntity, PosedEntity } from '../../model/types';
import { isBody, isJoint, isPosed } from '../../model/types';

/** Keys of each kind whose edits are repeated on the partner (identity, naming, locks and grouping are not). */
const MIRRORED_KEYS: Record<string, readonly string[]> = {
  body: [
    'position',
    'rotation',
    'shape',
    'parts',
    'meshId',
    'bodyType',
    'material',
    'linearDamping',
    'angularDamping',
    'gravityScale',
    'ccd',
    'canSleep',
    'velocity',
    'angularVelocity',
    'lockPosition',
    'lockRotation',
    'thrust',
    'ghost',
    'collision',
    'drag',
    'massOverride',
    'comOverride',
    'inertiaScale',
    'sleepThreshold',
    'tags',
    'layer',
    'components',
  ],
  soft: [
    'position',
    'rotation',
    'size',
    'resolution',
    'mass',
    'stiffness',
    'damping',
    'pin',
    'tearStrain',
    'selfCollide',
    'gravityScale',
    'linearDamping',
    'color',
    'roughness',
    'opacity',
  ],
  light: [
    'position',
    'rotation',
    'lightType',
    'color',
    'intensity',
    'range',
    'angle',
    'penumbra',
    'size',
    'castShadow',
    'enabled',
  ],
  path: ['position', 'rotation', 'points', 'closed', 'tension', 'color'],
  group: ['position', 'rotation'],
  joint: [
    'type',
    'anchorA',
    'anchorB',
    'axis',
    'limit',
    'motor',
    'spring',
    'ropeLength',
    'collideConnected',
    'components',
  ],
};

const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

export interface SymmetryEvents extends Record<string, unknown> {
  /** Mode, plane or pairing changed (the viewport indicator and the toolbox chip refresh). */
  change: undefined;
}

export interface SymmetryHost {
  store: SceneStore;
  /** Symmetry only acts on the document: while a simulation is live, edits are not mirrored. */
  simActive: () => boolean;
}

export class Symmetry extends Emitter<SymmetryEvents> {
  enabled = false;
  axis: Axis = 0;
  offset = 0;
  /** id → partner (both directions). */
  pairs = new Map<string, MirrorPair>();
  private busy = false;
  private readonly store: SceneStore;
  private readonly simActive: () => boolean;

  constructor(host: SymmetryHost) {
    super();
    this.store = host.store;
    this.simActive = host.simActive;
    this.store.on('change', (c) => this.onChange(c));
  }

  get plane(): MirrorPlane {
    return axisPlane(this.axis, this.offset);
  }

  get label(): string {
    return `${AXIS_NAMES[this.axis]}${this.offset ? ` ${this.offset > 0 ? '+' : '−'}${Math.abs(this.offset)}` : ''}`;
  }

  /** Number of mirrored pairs of posed entities currently tracked. */
  get pairCount(): number {
    let n = 0;
    for (const id of this.pairs.keys()) if (this.store.get(id) && !isJoint(this.store.get(id))) n++;
    return Math.floor(n / 2);
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) this.rederive();
    else this.pairs.clear();
    this.emit('change', undefined);
  }

  setPlane(axis: Axis, offset = 0): void {
    if (axis === this.axis && offset === this.offset) return;
    this.axis = axis;
    this.offset = offset;
    if (this.enabled) this.rederive();
    this.emit('change', undefined);
  }

  /** Find the mirror-image pairs among the current entities (replacing the tracked ones). */
  rederive(): number {
    this.pairs = findMirrorPairs(this.store.all(), this.plane);
    this.emit('change', undefined);
    return this.pairCount;
  }

  /** Run `fn` without the listener reacting to the edits it makes (commands that add or move both halves themselves). */
  suspended<T>(fn: () => T): T {
    const was = this.busy;
    this.busy = true;
    try {
      return fn();
    } finally {
      this.busy = was;
    }
  }

  /** Is `pl` the symmetry plane (so a mirror made about it produces pairs)? */
  isSymmetryPlane(pl: MirrorPlane): boolean {
    const mine = this.plane;
    const parallel =
      Math.abs(
        Math.abs(pl.normal[0] * mine.normal[0] + pl.normal[1] * mine.normal[1] + pl.normal[2] * mine.normal[2]) - 1,
      ) < 1e-9;
    const dist = Math.abs(
      (pl.point[0] - mine.point[0]) * mine.normal[0] +
        (pl.point[1] - mine.point[1]) * mine.normal[1] +
        (pl.point[2] - mine.point[2]) * mine.normal[2],
    );
    return parallel && dist < 1e-6;
  }

  /** Record pairs made elsewhere (a mirror copy): original id → copy id with the local flip axis used. */
  addPairs(idMap: ReadonlyMap<string, string>, axes: ReadonlyMap<string, Axis>): void {
    for (const [orig, copy] of idMap) {
      const axis = axes.get(orig) ?? 0;
      this.pairs.set(orig, { other: copy, axis });
      this.pairs.set(copy, { other: orig, axis });
    }
    this.emit('change', undefined);
  }

  /** Partner of an entity, if it is tracked and still exists. */
  partnerOf(id: string): string | undefined {
    const p = this.pairs.get(id);
    return p && this.store.has(p.other) ? p.other : undefined;
  }

  // ── the listener ────────────────────────────────────────────────────────────────────────────────────────

  private onChange(c: SceneChange): void {
    if (this.busy || this.store.replaying) return;
    if (!this.enabled) return;
    if (c.type === 'reset') {
      this.pairs = new Map();
      if (this.store.size) this.rederive();
      return;
    }
    if (this.simActive()) return;
    this.busy = true;
    try {
      this.store.amend(() => {
        if (c.type === 'update') this.onUpdate(c.ids, c.keys);
        else if (c.type === 'add') this.onAdd(c.ids);
        else if (c.type === 'remove') this.onRemove(c.removed);
      });
    } finally {
      this.busy = false;
    }
  }

  private meshMirror(): MirrorOptions {
    return {
      mirrorMesh: (meshId, axis) => {
        const a = this.store.getAsset(meshId);
        if (!a || a.kind !== 'mesh') return undefined;
        return this.store.addAsset(mirrorMeshAsset(a, axis), 'Mirror mesh');
      },
    };
  }

  private onUpdate(ids: string[], keys: Set<string>): void {
    const touched = new Set(ids);
    const patches: [string, Partial<Entity>][] = [];
    for (const id of ids) {
      const pair = this.pairs.get(id);
      if (!pair || touched.has(pair.other)) continue; // both halves edited at once: leave them as the user set them
      const a = this.store.get(id);
      const b = this.store.get(pair.other);
      if (!a || !b || a.kind !== b.kind || ('locked' in b && b.locked)) continue;
      const patch = this.patchFor(a, b, pair.axis, keys);
      if (patch) patches.push([b.id, patch]);
    }
    if (patches.length) this.store.updateMany(patches, 'Symmetry');
  }

  /** The fields of `b` that must change so that it is again the mirror image of `a`, restricted to `keys`. */
  private patchFor(a: Entity, b: Entity, axis: Axis, keys: Set<string>): Partial<Entity> | null {
    const allowed = MIRRORED_KEYS[a.kind] ?? [];
    const wanted = allowed.filter((k) => keys.has(k));
    if (!wanted.length) return null;
    const plane = this.plane;
    let fields: Record<string, unknown>;
    if (isJoint(a)) {
      const axA = a.bodyA ? this.pairs.get(a.bodyA)?.axis : undefined;
      const axB = a.bodyB ? this.pairs.get(a.bodyB)?.axis : undefined;
      fields = mirrorJointFields(a, plane, axA, axB);
    } else if (isPosed(a)) {
      const opts = keys.has('meshId') ? this.meshMirror() : {};
      fields = mirrorFields(a, plane, axis, opts);
    } else return null;
    const out: Record<string, unknown> = {};
    for (const k of wanted) {
      let v: unknown;
      if (k === 'components' && (isBody(a) || isJoint(a))) {
        // Fresh component ids (they are unique across the scene); parameters mirrored where the type says how.
        const fresh = cloneComponents(a.components, new Map());
        v = isBody(a) ? mirrorComponents(fresh, plane, axis) : fresh;
      } else v = k in fields ? fields[k] : (a as unknown as Record<string, unknown>)[k];
      if (!same(v, (b as unknown as Record<string, unknown>)[k])) out[k] = v;
    }
    return Object.keys(out).length ? out : null;
  }

  private onAdd(ids: string[]): void {
    const fresh = ids.map((id) => this.store.get(id)).filter((e): e is Entity => !!e && !this.pairs.has(e.id));
    if (!fresh.length) return;
    // Entities that arrive as a mirror-image pair (pasting both halves, an undo-less load …) pair up first.
    this.pairs = findMirrorPairs(this.store.all(), this.plane, { existing: this.pairs });
    const plane = this.plane;
    const lonely = fresh.filter((e): e is PosedEntity => isPosed(e) && !this.pairs.has(e.id) && !onPlane(e, plane));
    if (lonely.length) {
      const res = mirrorCopy(
        this.store.all(),
        lonely.map((e) => e.id),
        plane,
        this.meshMirror(),
      );
      const copies = res.entities.map((c) => (isPosed(c) ? { ...c, name: this.store.uniqueName(c.name) } : c));
      // Do not mirror a mirror: the copies of the entities we just created pair with them.
      this.store.add(copies, 'Symmetry', false);
      for (const [orig, copy] of res.idMap) {
        const axis = res.axes.get(orig);
        if (axis === undefined) continue;
        this.pairs.set(orig, { other: copy, axis });
        this.pairs.set(copy, { other: orig, axis });
      }
    }
    // Joints that arrived between bodies whose partners exist (and were not copied together with them).
    const joints: JointEntity[] = [];
    for (const e of fresh) if (isJoint(e) && !this.pairs.has(e.id)) joints.push(e);
    const made: Entity[] = [];
    for (const j of joints) {
      const pa = j.bodyA === null ? null : this.pairs.get(j.bodyA);
      const pb = j.bodyB === null ? null : this.pairs.get(j.bodyB);
      if (pa === undefined || pb === undefined) continue;
      const nj: JointEntity = {
        ...j,
        id: uid('j'),
        name: this.store.uniqueName(j.name),
        bodyA: pa ? pa.other : null,
        bodyB: pb ? pb.other : null,
        ...mirrorJointFields(j, plane, pa?.axis, pb?.axis),
        components: cloneComponents(j.components, new Map()),
      };
      made.push(nj);
      this.pairs.set(j.id, { other: nj.id, axis: pa?.axis ?? pb?.axis ?? 0 });
      this.pairs.set(nj.id, { other: j.id, axis: pa?.axis ?? pb?.axis ?? 0 });
    }
    if (made.length) this.store.add(made, 'Symmetry', false);
    this.emit('change', undefined);
  }

  private onRemove(removed: Entity[]): void {
    const gone = new Set(removed.map((e) => e.id));
    const victims: string[] = [];
    for (const e of removed) {
      const pair = this.pairs.get(e.id);
      if (!pair || gone.has(pair.other)) continue;
      const p = this.store.get(pair.other);
      if (!p || ('locked' in p && p.locked)) continue;
      victims.push(pair.other);
    }
    if (victims.length) this.store.remove(victims, 'Symmetry');
    this.emit('change', undefined);
  }
}
