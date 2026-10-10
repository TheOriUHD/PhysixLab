/**
 * VZ-30: instanced rendering. Bodies that share one geometry and one (non-colour) material are drawn by a single
 * `InstancedMesh` with a per-instance colour, so a 300-ball pit costs a handful of draw calls instead of 300.
 *
 * The per-body `Mesh` of each `BodyView` stays alive as the pose carrier (joints, overlays, the gizmo and the outline
 * read it) and as the "promoted" stand-in: a selected / hovered body is drawn through its own mesh (outline pass,
 * emissive highlight) while its instance slot collapses to zero scale. Picking goes through the pool mesh, which maps
 * an `instanceId` back to the entity id (`userData.instanceIds`).
 */
import type { BufferGeometry, Material, Object3D, Color } from 'three';
import { DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three';

/** Pools exist for ≥ MIN_POOL identical bodies and dissolve when they drop below DISSOLVE_BELOW (hysteresis). */
export const MIN_POOL = 8;
export const DISSOLVE_BELOW = 4;

/** What the pool needs to read from a body view. */
export interface PoolMember {
  readonly id: string;
  readonly mesh: Object3D;
  /** Visual scale of the body's shape (shapeVisualScale). */
  readonly scale: readonly [number, number, number];
  /** Not hidden, not fallen out of the world, and not promoted to its own mesh. */
  poolVisible: boolean;
  /** World velocity (m/s), for the motion-blur velocity buffer. */
  readonly vel: Vector3;
  /** Accumulated impact damage 0..1 (VZ-41), written to the per-instance `aDamage` attribute. */
  damage: number;
  /** Slot in the pool (maintained by the pool; -1 when not pooled). */
  slot: number;
}

const SLOT_STRIDE = 7;

export class InstancePool {
  mesh: InstancedMesh;
  private capacity: number;
  private readonly geometry: BufferGeometry;
  private lastVel: Float32Array;
  private lastDmg: Float32Array;
  private members: PoolMember[] = [];
  private lastPose: Float32Array;
  private lastShown: Uint8Array;
  private colorDirty = true;
  private matrixDirty = true;
  private readonly m = new Matrix4();
  private readonly p = new Vector3();
  private readonly q = new Quaternion();
  private readonly s = new Vector3();
  private static readonly ZERO = new Matrix4().makeScale(0, 0, 0);

  constructor(
    readonly key: string,
    sourceGeometry: BufferGeometry,
    readonly material: Material,
    private parent: Object3D,
    initial = 16,
  ) {
    // A private copy: it carries this pool's per-instance velocity attribute (`aVel`).
    this.geometry = sourceGeometry.clone();
    this.capacity = initial;
    this.lastPose = new Float32Array(initial * SLOT_STRIDE);
    this.lastShown = new Uint8Array(initial);
    this.lastVel = new Float32Array(initial * 3);
    this.lastDmg = new Float32Array(initial);
    this.mesh = this.makeMesh(initial);
    parent.add(this.mesh);
  }

  get size(): number {
    return this.members.length;
  }

  private makeMesh(capacity: number): InstancedMesh {
    const vel = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    vel.setUsage(DynamicDrawUsage);
    this.geometry.setAttribute('aVel', vel);
    const dmg = new InstancedBufferAttribute(new Float32Array(capacity), 1);
    dmg.setUsage(DynamicDrawUsage);
    this.geometry.setAttribute('aDamage', dmg);
    const mesh = new InstancedMesh(this.geometry, this.material, capacity);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
    mesh.instanceColor.setUsage(DynamicDrawUsage);
    mesh.count = 0;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.instanceIds = [] as string[];
    mesh.userData.pool = this;
    return mesh;
  }

  add(member: PoolMember): void {
    if (this.members.length >= this.capacity) this.grow();
    const slot = this.members.length;
    member.slot = slot;
    this.members.push(member);
    this.mesh.count = this.members.length;
    (this.mesh.userData.instanceIds as string[])[slot] = member.id;
    this.lastShown[slot] = 2; // force a write
    this.matrixDirty = this.colorDirty = true;
  }

  remove(member: PoolMember): void {
    const slot = member.slot;
    if (slot < 0 || this.members[slot] !== member) return;
    member.slot = -1;
    const last = this.members.length - 1;
    if (slot !== last) {
      const moved = this.members[last];
      moved.slot = slot;
      this.members[slot] = moved;
      (this.mesh.userData.instanceIds as string[])[slot] = moved.id;
      const ca = this.mesh.instanceColor!.array as Float32Array;
      ca.copyWithin(slot * 3, last * 3, last * 3 + 3);
      this.lastShown[slot] = 2;
    }
    this.members.pop();
    (this.mesh.userData.instanceIds as string[]).length = this.members.length;
    this.mesh.count = this.members.length;
    this.matrixDirty = this.colorDirty = true;
  }

  private grow(): void {
    const cap = this.capacity * 2;
    const old = this.mesh;
    const next = this.makeMesh(cap);
    (next.instanceMatrix.array as Float32Array).set(old.instanceMatrix.array);
    (next.instanceColor!.array as Float32Array).set(old.instanceColor!.array);
    next.count = old.count;
    next.userData.instanceIds = old.userData.instanceIds as string[];
    const pose = new Float32Array(cap * SLOT_STRIDE);
    pose.set(this.lastPose);
    this.lastPose = pose;
    const shown = new Uint8Array(cap);
    shown.set(this.lastShown);
    this.lastShown = shown;
    const lv = new Float32Array(cap * 3);
    lv.set(this.lastVel);
    this.lastVel = lv;
    const ld = new Float32Array(cap);
    ld.set(this.lastDmg);
    this.lastDmg = ld;
    (this.geometry.getAttribute('aDamage').array as Float32Array).set(this.lastDmg.subarray(0, this.members.length));
    (this.geometry.getAttribute('aVel').array as Float32Array).set(this.lastVel.subarray(0, this.members.length * 3));
    this.capacity = cap;
    this.parent.remove(old);
    old.dispose();
    this.mesh = next;
    this.parent.add(next);
    this.matrixDirty = this.colorDirty = true;
  }

  /** Per-instance colour of a member. */
  setColor(member: PoolMember, color: Color): void {
    if (member.slot >= 0) this.setColorAt(member.slot, color);
  }

  setColorAt(slot: number, color: Color): void {
    const a = this.mesh.instanceColor!.array as Float32Array;
    const o = slot * 3;
    if (a[o] !== color.r || a[o + 1] !== color.g || a[o + 2] !== color.b) {
      a[o] = color.r;
      a[o + 1] = color.g;
      a[o + 2] = color.b;
      this.colorDirty = true;
    }
  }

  slotMember(slot: number): PoolMember | undefined {
    return this.members[slot];
  }

  /** Copy the members' current poses into the instance matrices (only what changed). */
  flush(): void {
    const arr = this.mesh.instanceMatrix.array as Float32Array;
    const n = this.members.length;
    for (let i = 0; i < n; i++) {
      const mem = this.members[i];
      const o = i * SLOT_STRIDE;
      if (!mem.poolVisible) {
        if (this.lastShown[i] !== 0) {
          InstancePool.ZERO.toArray(arr, i * 16);
          this.lastShown[i] = 0;
          this.matrixDirty = true;
        }
        continue;
      }
      const pos = mem.mesh.position;
      const rot = mem.mesh.quaternion;
      const lp = this.lastPose;
      if (
        this.lastShown[i] === 1 &&
        lp[o] === pos.x &&
        lp[o + 1] === pos.y &&
        lp[o + 2] === pos.z &&
        lp[o + 3] === rot.x &&
        lp[o + 4] === rot.y &&
        lp[o + 5] === rot.z &&
        lp[o + 6] === rot.w
      )
        continue;
      lp[o] = pos.x;
      lp[o + 1] = pos.y;
      lp[o + 2] = pos.z;
      lp[o + 3] = rot.x;
      lp[o + 4] = rot.y;
      lp[o + 5] = rot.z;
      lp[o + 6] = rot.w;
      this.lastShown[i] = 1;
      this.s.set(mem.scale[0], mem.scale[1], mem.scale[2]);
      this.m.compose(this.p.copy(pos), this.q.copy(rot), this.s).toArray(arr, i * 16);
      this.matrixDirty = true;
    }
    const va = this.geometry.getAttribute('aVel') as InstancedBufferAttribute;
    const vArr = va.array as Float32Array;
    let velDirty = false;
    for (let i = 0; i < n; i++) {
      const v = this.members[i].vel;
      const o = i * 3;
      if (this.lastVel[o] !== v.x || this.lastVel[o + 1] !== v.y || this.lastVel[o + 2] !== v.z) {
        this.lastVel[o] = vArr[o] = v.x;
        this.lastVel[o + 1] = vArr[o + 1] = v.y;
        this.lastVel[o + 2] = vArr[o + 2] = v.z;
        velDirty = true;
      }
    }
    if (velDirty) va.needsUpdate = true;
    const da = this.geometry.getAttribute('aDamage') as InstancedBufferAttribute;
    let dmgDirty = false;
    for (let i = 0; i < n; i++) {
      const d = this.members[i].damage;
      if (this.lastDmg[i] !== d) {
        this.lastDmg[i] = (da.array as Float32Array)[i] = d;
        dmgDirty = true;
      }
    }
    if (dmgDirty) da.needsUpdate = true;
    if (this.matrixDirty) {
      this.mesh.instanceMatrix.needsUpdate = true;
      // Culling and raycasting use the bounding sphere of the instances: recompute lazily.
      this.mesh.boundingSphere = null;
      this.mesh.boundingBox = null;
      this.matrixDirty = false;
    }
    if (this.colorDirty) {
      this.mesh.instanceColor!.needsUpdate = true;
      this.colorDirty = false;
    }
  }

  /** World matrix of one instance (used to orient the hit normal). */
  instanceMatrix(slot: number, out: Matrix4): Matrix4 {
    return this.mesh.getMatrixAt(slot, out);
  }

  dispose(): void {
    this.parent.remove(this.mesh);
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
