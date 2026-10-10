/**
 * The look of a placement ghost: the geometry of "what is about to be added" built from a list of entities in the frame
 * of their pose origin — a single primitive, a soft body's surface, a light's icon, or a whole prefab with every body,
 * soft body and joint. Everything is merged into at most three geometries (a translucent fill, an outline, faint
 * joint / icon lines), so a ghost costs three draw calls however many bodies it shows, and moving it is one
 * transform. Nothing here touches the scene: `GhostView` owns the meshes, this only returns geometry that the
 * caller must `dispose()`.
 */
import {
  BoxGeometry,
  BufferGeometry,
  EdgesGeometry,
  Float32BufferAttribute,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  Vector3,
  WireframeGeometry,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Quat, Vec3 } from '../core/math';
import { qrot, vadd } from '../core/math';
import { shapeGeometry, shapeVisualScale } from '../model/shapeRegistry';
import { softSurface, torusSurface, TYRE_ACROSS, tyreGeometry } from '../model/softMesh';
import type { BodyEntity, Entity, JointEntity, LightEntity, PathEntity, ShapeSpec, SoftEntity } from '../model/types';
import { isBody, isJoint, isLight, isPath, isSoft } from '../model/types';
import { GEOMETRY_KIT } from './geometryKit';

/** The geometry of one ghost. `fill` is triangles, `edges` the outline / lattice, `faint` joint links and icons. */
export interface GhostGeometry {
  fill: BufferGeometry | null;
  edges: BufferGeometry | null;
  faint: BufferGeometry | null;
  /** Triangles in `fill`. */
  triangles: number;
  /** Bodies and soft bodies drawn. */
  objects: number;
  dispose(): void;
}

/** Triangles a prefab ghost may draw before the remaining bodies are shown as boxes. */
export const GHOST_TRIANGLE_BUDGET = 120_000;

const tmpM = new Matrix4();
const tmpV = new Vector3();
const tmpQ = new Quaternion();
const ONE = new Vector3(1, 1, 1);

function matrixOf(position: Vec3, rotation: Quat, scale?: Vec3): Matrix4 {
  tmpV.set(position[0], position[1], position[2]);
  tmpQ.set(rotation[0], rotation[1], rotation[2], rotation[3]);
  const s = scale ? new Vector3(scale[0], scale[1], scale[2]) : ONE;
  return new Matrix4().compose(tmpV, tmpQ, s);
}

/** A copy of `g` as plain non-indexed triangles with only position and normal, moved by `m`. */
function bake(g: BufferGeometry, m: Matrix4): BufferGeometry {
  const flat = g.index ? g.toNonIndexed() : g.clone();
  for (const name of Object.keys(flat.attributes))
    if (name !== 'position' && name !== 'normal') flat.deleteAttribute(name);
  flat.applyMatrix4(m);
  if (!flat.getAttribute('normal')) flat.computeVertexNormals();
  return flat;
}

const trianglesOf = (g: BufferGeometry): number => (g.index ? g.index.count : g.getAttribute('position').count) / 3;

/** Push the segments of a line-segment geometry (already in the target frame) onto `out`. */
function pushSegments(out: number[], g: BufferGeometry): void {
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) out.push(p.getX(i), p.getY(i), p.getZ(i));
}

function pushLine(out: number[], a: Vec3, b: Vec3): void {
  out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
}

/** The pieces a body is drawn from: its collider parts, or its single shape. */
function piecesOf(b: BodyEntity): { shape: ShapeSpec; position: Vec3; rotation: Quat }[] {
  if (b.parts?.length) {
    return b.parts
      .filter((p) => p.visible !== false)
      .map((p) => ({ shape: p.shape, position: p.position, rotation: p.rotation }));
  }
  return [{ shape: b.shape, position: [0, 0, 0], rotation: [0, 0, 0, 1] }];
}

interface Acc {
  fills: BufferGeometry[];
  edges: number[];
  faint: number[];
  triangles: number;
  objects: number;
}

function addBody(acc: Acc, b: BodyEntity, budget: number): void {
  if (b.hidden) return;
  acc.objects++;
  for (const piece of piecesOf(b)) {
    const world = matrixOf(b.position, b.rotation).multiply(matrixOf(piece.position, piece.rotation));
    let geo: BufferGeometry;
    if (acc.triangles >= budget) {
      // over budget: the rest of the assembly is shown as boxes of the right size
      const s = piece.shape.size;
      geo = new BoxGeometry(Math.max(0.02, s[0]), Math.max(0.02, s[1]), Math.max(0.02, s[2]));
      const baked = bake(geo, world);
      geo.dispose();
      acc.fills.push(baked);
      acc.triangles += trianglesOf(baked);
      continue;
    }
    const raw = shapeGeometry(GEOMETRY_KIT, piece.shape);
    const sc = shapeVisualScale(piece.shape);
    const baked = bake(raw, world.multiply(tmpM.makeScale(sc[0], sc[1], sc[2])));
    raw.dispose();
    acc.fills.push(baked);
    acc.triangles += trianglesOf(baked);
    const edges = new EdgesGeometry(baked, 25);
    pushSegments(acc.edges, edges);
    edges.dispose();
  }
}

/** Local-frame geometry of a soft body's resting surface (what the editor draws for it before it simulates). */
function softParts(s: SoftEntity): { fill: BufferGeometry | null; lines: BufferGeometry | null; cable?: Vec3[] } {
  const [x, y, z] = s.size;
  const seg = Math.min(6, Math.max(1, s.resolution - 1));
  switch (s.type) {
    case 'jelly': {
      const fill = new BoxGeometry(x, y, z);
      const lattice = new WireframeGeometry(new BoxGeometry(x, y, z, seg, seg, seg));
      return { fill, lines: lattice };
    }
    case 'balloon': {
      const fill = new SphereGeometry(x / 2, 32, 20);
      return { fill, lines: new WireframeGeometry(new SphereGeometry(x / 2, 14, 9)) };
    }
    case 'cloth': {
      const n = Math.min(14, Math.max(3, Math.round(s.resolution * 0.75)));
      const plane = new PlaneGeometry(x, z, n, n).rotateX(-Math.PI / 2);
      return { fill: plane, lines: new WireframeGeometry(plane) };
    }
    case 'cable': {
      const pts: Vec3[] = [];
      const n = 24;
      for (let i = 0; i <= n; i++) pts.push([(i / n - 0.5) * x, 0, 0]);
      return { fill: null, lines: null, cable: pts };
    }
    case 'mesh': {
      const surf = softSurface({ ...s.shape, size: [x, y, z] }) ?? softSurface({ type: 'box', size: [x, y, z] });
      if (!surf) return { fill: new BoxGeometry(x, y, z), lines: null };
      const g = new BufferGeometry();
      g.setAttribute('position', new Float32BufferAttribute(surf.vertices.slice(), 3));
      g.setIndex(Array.from(surf.indices));
      g.computeVertexNormals();
      return { fill: g, lines: new EdgesGeometry(g, 28) };
    }
    case 'tyre': {
      const t = tyreGeometry(s.size);
      const surf = torusSurface(t.major, t.radial, t.axial, Math.max(12, s.resolution), TYRE_ACROSS);
      const g = new BufferGeometry();
      g.setAttribute('position', new Float32BufferAttribute(surf.vertices.slice(), 3));
      g.setIndex(Array.from(surf.indices));
      g.computeVertexNormals();
      return { fill: g, lines: null };
    }
  }
}

function addSoft(acc: Acc, s: SoftEntity): void {
  if (s.hidden) return;
  acc.objects++;
  const world = matrixOf(s.position, s.rotation);
  const parts = softParts(s);
  if (parts.fill) {
    const baked = bake(parts.fill, world);
    acc.fills.push(baked);
    acc.triangles += trianglesOf(baked);
    parts.fill.dispose();
  }
  if (parts.lines) {
    parts.lines.applyMatrix4(world);
    pushSegments(acc.faint, parts.lines); // the lattice is a texture of the surface, not its outline
    parts.lines.dispose();
  }
  if (parts.cable) {
    const w = parts.cable.map((p) => {
      tmpV.set(p[0], p[1], p[2]).applyMatrix4(world);
      return [tmpV.x, tmpV.y, tmpV.z] as Vec3;
    });
    for (let i = 0; i + 1 < w.length; i++) pushLine(acc.edges, w[i], w[i + 1]);
  }
}

/** A light's icon: a small octahedron, plus the cone / arrow / panel that shows where it points. */
function addLight(acc: Acc, l: LightEntity): void {
  if (l.hidden) return;
  const at = l.position;
  const r = 0.16;
  const o: Vec3[] = [
    [r, 0, 0],
    [-r, 0, 0],
    [0, r, 0],
    [0, -r, 0],
    [0, 0, r],
    [0, 0, -r],
  ];
  const v = (p: Vec3): Vec3 => vadd(at, p);
  for (const a of [0, 1]) for (const b of [2, 3]) pushLine(acc.faint, v(o[a]), v(o[b]));
  for (const a of [0, 1]) for (const b of [4, 5]) pushLine(acc.faint, v(o[a]), v(o[b]));
  for (const a of [2, 3]) for (const b of [4, 5]) pushLine(acc.faint, v(o[a]), v(o[b]));
  const dir = (p: Vec3): Vec3 => vadd(at, qrot(l.rotation, p)); // a light looks along its local −Z
  if (l.lightType === 'spot') {
    const len = 1.2;
    const rad = Math.tan(l.angle) * len;
    const ring: Vec3[] = Array.from({ length: 16 }, (_, i) => {
      const a = (i / 16) * Math.PI * 2;
      return dir([Math.cos(a) * rad, Math.sin(a) * rad, -len]);
    });
    for (let i = 0; i < ring.length; i++) pushLine(acc.faint, ring[i], ring[(i + 1) % ring.length]);
    for (let i = 0; i < ring.length; i += 4) pushLine(acc.faint, at, ring[i]);
  } else if (l.lightType === 'directional') {
    for (const [dx, dy] of [
      [0, 0],
      [0.3, 0],
      [-0.3, 0],
      [0, 0.3],
      [0, -0.3],
    ])
      pushLine(acc.faint, dir([dx, dy, 0]), dir([dx, dy, -1.2]));
  } else if (l.lightType === 'area') {
    const [w, h] = l.size;
    const c: Vec3[] = [
      dir([-w / 2, -h / 2, 0]),
      dir([w / 2, -h / 2, 0]),
      dir([w / 2, h / 2, 0]),
      dir([-w / 2, h / 2, 0]),
    ];
    for (let i = 0; i < 4; i++) pushLine(acc.faint, c[i], c[(i + 1) % 4]);
    pushLine(acc.faint, at, dir([0, 0, -0.8]));
  } else {
    // point: a small cross of rays
    for (const p of o) pushLine(acc.faint, v(p), v([p[0] * 2.2, p[1] * 2.2, p[2] * 2.2]));
  }
}

function addPath(acc: Acc, p: PathEntity): void {
  if (p.hidden) return;
  const w = p.points.map((q) => vadd(p.position, qrot(p.rotation, q)));
  for (let i = 0; i + 1 < w.length; i++) pushLine(acc.edges, w[i], w[i + 1]);
}

/** A joint as a faint link between its two anchors (a short cross where they coincide). */
function addJoint(acc: Acc, j: JointEntity, bodies: Map<string, BodyEntity>): void {
  const anchor = (id: string | null, local: Vec3): Vec3 | null => {
    if (!id) return local;
    const b = bodies.get(id);
    return b ? vadd(b.position, qrot(b.rotation, local)) : null;
  };
  const a = anchor(j.bodyA, j.anchorA);
  const bPoint = anchor(j.bodyB, j.anchorB);
  if (!a) return;
  const b = bPoint ?? a;
  const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  if (d > 0.03) pushLine(acc.faint, a, b);
  const r = 0.07;
  for (const p of [a, b]) {
    pushLine(acc.faint, vadd(p, [-r, 0, 0]), vadd(p, [r, 0, 0]));
    pushLine(acc.faint, vadd(p, [0, -r, 0]), vadd(p, [0, r, 0]));
    pushLine(acc.faint, vadd(p, [0, 0, -r]), vadd(p, [0, 0, r]));
  }
}

const lineGeometry = (pts: number[]): BufferGeometry | null => {
  if (!pts.length) return null;
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pts, 3));
  return g;
};

/** Build the ghost of an entity list around its pose origin. Dispose the result when the ghost goes away. */
export function buildGhostGeometry(entities: readonly Entity[], budget = GHOST_TRIANGLE_BUDGET): GhostGeometry {
  const acc: Acc = { fills: [], edges: [], faint: [], triangles: 0, objects: 0 };
  const bodies = new Map<string, BodyEntity>();
  for (const e of entities) if (isBody(e)) bodies.set(e.id, e);
  for (const e of entities) {
    if (isBody(e)) addBody(acc, e, budget);
    else if (isSoft(e)) addSoft(acc, e);
    else if (isLight(e)) addLight(acc, e);
    else if (isPath(e)) addPath(acc, e);
    else if (isJoint(e)) addJoint(acc, e, bodies);
  }
  const fill = acc.fills.length ? mergeGeometries(acc.fills, false) : null;
  for (const g of acc.fills) g.dispose();
  const edges = lineGeometry(acc.edges);
  const faint = lineGeometry(acc.faint);
  return {
    fill,
    edges,
    faint,
    triangles: acc.triangles,
    objects: acc.objects,
    dispose() {
      fill?.dispose();
      edges?.dispose();
      faint?.dispose();
    },
  };
}
