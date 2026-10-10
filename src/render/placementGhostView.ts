/**
 * What a placement ghost looks like in the viewport (see `src/app/placementGhost.ts` for the behaviour): the translucent
 * ghost of the thing itself, a landing marker on the surface under it (a ring with a crosshair), a thin drop line from
 * the ghost down to the surface when it hovers, and a soft contact shadow. Tinted cyan when the spot is fine, amber
 * when it is allowed but questionable (it overlaps something solid) and red when it is refused.
 *
 * The view owns every geometry and material it creates and frees them in `dispose()`. Moving it is O(1): a few
 * transforms and the two points of the drop line. None of its objects can be hit by a ray (`raycast` is a no-op) or
 * carry an entity id, so it takes no part in picking, and nothing here is known to the physics.
 */
import {
  CircleGeometry,
  DoubleSide,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  ShaderMaterial,
  Vector3,
  type BufferGeometry,
  type InterleavedBufferAttribute,
  type Object3D,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import type { Quat, Vec3 } from '../core/math';
import type { GhostGeometry } from './ghostGeometry';

export type GhostTint = 'ok' | 'warn' | 'bad';

const TINT: Record<GhostTint, number> = { ok: 0x3ddcff, warn: 0xffb347, bad: 0xff5d73 };
const UP = new Vector3(0, 1, 0);
const tmp = new Vector3();
const noRaycast = (): void => undefined;

/** The ring + crosshair + centre dot of the landing marker, flat in the XZ plane, radius 1. */
function markerGeometry(thickness: number): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const ring = new RingGeometry(1 - thickness, 1, 56).rotateX(-Math.PI / 2);
  parts.push(ring.toNonIndexed());
  ring.dispose();
  // four ticks reaching outwards from the ring
  for (let i = 0; i < 4; i++) {
    const tick = new PlaneGeometry(thickness * 0.8, 0.28).rotateX(-Math.PI / 2).translate(0, 0, -(1 + 0.04 + 0.14));
    tick.rotateY((i * Math.PI) / 2);
    parts.push(tick.toNonIndexed());
    tick.dispose();
  }
  // and a small cross + dot in the middle
  const dot = new CircleGeometry(thickness * 1.2, 16).rotateX(-Math.PI / 2);
  parts.push(dot.toNonIndexed());
  dot.dispose();
  for (const g of parts) {
    g.deleteAttribute('normal');
    g.deleteAttribute('uv');
  }
  const merged = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  return merged;
}

const SHADOW_VERT = `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const SHADOW_FRAG = `varying vec2 vUv; uniform float uOpacity;
void main() { float d = length(vUv - 0.5) * 2.0; float a = clamp(1.0 - d, 0.0, 1.0); gl_FragColor = vec4(0.0, 0.0, 0.0, a * a * uOpacity); }`;

export class GhostView {
  /** The ghost itself; moved with the pose. */
  readonly body = new Group();
  /** The marker, shadow and drop line live in world space beside it. */
  readonly marks = new Group();

  private fill: Mesh | null = null;
  private edges: LineSegments | null = null;
  private faint: LineSegments | null = null;
  private readonly fillMat = new MeshLambertMaterial({
    color: TINT.ok,
    emissive: TINT.ok,
    emissiveIntensity: 0.42,
    transparent: true,
    opacity: 0.42,
    side: DoubleSide,
    depthWrite: false,
  });
  private readonly edgeMat = new LineBasicMaterial({
    color: TINT.ok,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
  });
  private readonly faintMat = new LineBasicMaterial({
    color: TINT.ok,
    transparent: true,
    opacity: 0.55,
    depthTest: false,
  });
  private readonly markerMat = new MeshBasicMaterial({
    color: TINT.ok,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    depthWrite: false,
    side: DoubleSide,
  });
  /** A fat (2 px) line: plain GL lines are one pixel wide and vanish against a busy scene. */
  private readonly dropMat = new LineMaterial({
    color: TINT.ok,
    linewidth: 2.2,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    worldUnits: false,
  });
  private readonly shadowMat = new ShaderMaterial({
    vertexShader: SHADOW_VERT,
    fragmentShader: SHADOW_FRAG,
    uniforms: { uOpacity: { value: 0.5 } },
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  private readonly marker: Mesh;
  private readonly shadow: Mesh;
  private readonly dropLine: LineSegments2;
  private readonly dropGeo = new LineSegmentsGeometry();
  private readonly markerGeo: BufferGeometry;
  private readonly shadowGeo: BufferGeometry;
  private readonly q = new Quaternion();
  private tint: GhostTint = 'ok';
  private disposed = false;

  constructor(
    private parent: Object3D,
    geometry: GhostGeometry,
    footprint: number,
  ) {
    this.body.name = 'placement-ghost';
    this.marks.name = 'placement-ghost-marks';
    if (geometry.fill) {
      this.fill = new Mesh(geometry.fill, this.fillMat);
      this.fill.renderOrder = 990;
      this.body.add(this.fill);
    }
    if (geometry.edges) {
      this.edges = new LineSegments(geometry.edges, this.edgeMat);
      this.edges.renderOrder = 991;
      this.body.add(this.edges);
    }
    if (geometry.faint) {
      this.faint = new LineSegments(geometry.faint, this.faintMat);
      this.faint.renderOrder = 991;
      this.body.add(this.faint);
    }
    // landing marker: flat on the surface, sized to the footprint
    this.markerGeo = markerGeometry(Math.min(0.12, Math.max(0.03, 0.05 / Math.max(0.3, footprint) + 0.02)));
    this.marker = new Mesh(this.markerGeo, this.markerMat);
    this.marker.renderOrder = 992;
    this.marker.scale.setScalar(footprint);
    // soft contact shadow: a radial fade, twice the footprint
    this.shadowGeo = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.shadow = new Mesh(this.shadowGeo, this.shadowMat);
    this.shadow.renderOrder = 980;
    this.shadow.scale.setScalar(footprint * 2.6);
    // drop line
    this.dropGeo.setPositions([0, 0, 0, 0, 1, 0]);
    this.dropLine = new LineSegments2(this.dropGeo, this.dropMat);
    this.dropLine.renderOrder = 992;
    this.dropLine.frustumCulled = false;
    this.marks.add(this.shadow, this.marker, this.dropLine);
    for (const root of [this.body, this.marks]) {
      root.traverse((o) => {
        o.raycast = noRaycast; // a ghost is never hit by a pick ray
        o.matrixAutoUpdate = true;
      });
    }
    this.setVisible(false);
    parent.add(this.body, this.marks);
  }

  /** Show or hide the whole ghost (it is hidden while the pointer is over a panel). */
  setVisible(v: boolean): void {
    this.body.visible = v;
    this.marks.visible = v;
  }

  get visible(): boolean {
    return this.body.visible;
  }

  setPose(position: Vec3, rotation: Quat): void {
    this.body.position.set(position[0], position[1], position[2]);
    this.body.quaternion.set(rotation[0], rotation[1], rotation[2], rotation[3]);
  }

  /**
   * Put the marks: the surface point being touched and its (unit) normal, and how far the ghost hovers above it along
   * that normal (`height` > 0 draws the drop line).
   */
  setContact(point: Vec3, normal: Vec3, height: number): void {
    const n = tmp.set(normal[0], normal[1], normal[2]);
    this.q.setFromUnitVectors(UP, n);
    this.marker.position.set(point[0] + n.x * 0.006, point[1] + n.y * 0.006, point[2] + n.z * 0.006);
    this.marker.quaternion.copy(this.q);
    this.shadow.position.set(point[0] + n.x * 0.003, point[1] + n.y * 0.003, point[2] + n.z * 0.003);
    this.shadow.quaternion.copy(this.q);
    (this.shadowMat.uniforms.uOpacity as { value: number }).value = Math.max(0.14, 0.55 - 0.1 * Math.max(0, height));
    const show = height > 0.02;
    this.dropLine.visible = show;
    if (show) {
      // the segment lives in one interleaved buffer: write the two points in place (no allocation per move)
      const start = this.dropGeo.getAttribute('instanceStart') as InterleavedBufferAttribute;
      const a = start.data.array as Float32Array;
      a[0] = point[0];
      a[1] = point[1];
      a[2] = point[2];
      a[3] = point[0] + n.x * height;
      a[4] = point[1] + n.y * height;
      a[5] = point[2] + n.z * height;
      start.data.needsUpdate = true;
    }
  }

  setTint(t: GhostTint): void {
    if (t === this.tint) return;
    this.tint = t;
    const c = TINT[t];
    this.fillMat.color.setHex(c);
    this.fillMat.emissive.setHex(c);
    this.edgeMat.color.setHex(c);
    this.faintMat.color.setHex(c);
    this.dropMat.color.setHex(c);
    this.markerMat.color.setHex(c);
  }

  /** Fade the ghost (used while it only shows where Enter would place it, with the pointer off the viewport). */
  setDim(dim: boolean): void {
    this.fillMat.opacity = dim ? 0.22 : 0.42;
    this.edgeMat.opacity = dim ? 0.5 : 0.95;
  }

  get tinted(): GhostTint {
    return this.tint;
  }

  /** Number of three.js objects this view has put in the scene (the ghost's meshes and its marks). */
  get objectCount(): number {
    let n = 0;
    this.body.traverse(() => n++);
    this.marks.traverse(() => n++);
    return n;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.parent.remove(this.body, this.marks);
    this.fill?.geometry.dispose();
    this.edges?.geometry.dispose();
    this.faint?.geometry.dispose();
    this.markerGeo.dispose();
    this.shadowGeo.dispose();
    this.dropGeo.dispose();
    for (const m of [this.fillMat, this.edgeMat, this.faintMat, this.markerMat, this.dropMat, this.shadowMat])
      m.dispose();
  }
}
