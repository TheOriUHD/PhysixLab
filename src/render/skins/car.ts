/**
 * `car.body` (VZ-42): a detailed procedural car shell drawn on the chassis box of the drivable-car template.
 *
 * Frame: the root is the chassis body's local frame in metres (+X forward, +Y up, +Z right; the driver sits on −Z).
 * The chassis box is 2.3 x 0.35 x 1.2 and its centre is the origin, so the shell spans x in ±1.42, the belt line is
 * y = 0.30 and the roof y = 0.84. Everything is built once (merged per material); `update` only moves
 *  - the four suspension assemblies (lower arms, damper, coil spring) and brake calipers, from the *wheel bodies'*
 *    current world poses (tag `car-wheel`) expressed in the chassis frame - so compression is the real slider travel;
 *  - the tail-light glow: dim always, bright while `KeyS` (the template's brake / reverse key) is held;
 *  - the paint colour, which follows the chassis body's live material colour (tag `car-body`), so a colour edit in
 *    the inspector needs no skin rebuild.
 * Headlights are emissive and always on. The wheels themselves are the `car.wheel` skin on the physics wheel bodies.
 */
import type { BufferGeometry } from 'three';
import {
  Color,
  CylinderGeometry,
  Curve,
  DoubleSide,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  Shape,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { Batch, Lease, segment, stretch, tm } from './carKit';
import { carWheelSkin } from './carWheel';
import type { SkinDef, SkinFrame, SkinInstance } from './types';

export const CAR_BODY_TAG = 'car-body';
export const CAR_WHEEL_TAG = 'car-wheel';
const MAX_WHEELS = 4;
/** Emissive intensity of the tail-lights: parking glow and full brake light. */
export const TAIL_IDLE = 0.35;
export const TAIL_BRAKE = 3.4;
const HEAD_INTENSITY = 1.0;
/** The brake / reverse key of the template's rear axle motors. */
export const BRAKE_KEY = 'KeyS';

// ── shape constants (metres, chassis frame) ──────────────────────────────────────────────────────────────────
const W = 0.74; // outer half width of the lower body
const CORE = 0.4; // half width of the centre tub (the wheel wells are cut into the side pieces only)
const BELT = 0.3;
const FLOOR = -0.19;
const ROOF = 0.8;
const ARCH_Y = -0.26;
const ARCH_R = 0.42;
const ARCH_X = 0.85;
const GLASS_W = 0.64;

const sstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Width factor of the body at (x, y): narrow nose / tail, tumblehome above the doors, tucked-in sills. */
function widthFactor(x: number, y: number): number {
  const taper = 1 - 0.17 * sstep(0.8, 1.45, Math.abs(x));
  const t = Math.min(1, Math.max(0, y / 0.3));
  const tuck = 1 - 0.1 * (1 - sstep(-0.19, -0.04, y));
  return taper * (1 - 0.07 * t * t) * tuck;
}
/** Half width of the greenhouse at height y. */
const glassHalf = (y: number) => {
  const t = (y - BELT) / (ROOF - BELT);
  return GLASS_W * (1 - 0.25 * t * t);
};
/** z of the painted side surface at (x, y). */
const surfaceZ = (x: number, y: number) => W * widthFactor(x, y);

function bodyOutline(arches: boolean): Shape {
  const s = new Shape();
  s.moveTo(-1.4, -0.12);
  s.lineTo(-1.4, 0.1);
  s.lineTo(-1.37, 0.22);
  s.lineTo(-1.25, 0.285);
  s.lineTo(-1.0, BELT);
  s.lineTo(0.4, BELT);
  s.lineTo(1.0, 0.275);
  s.lineTo(1.34, 0.2);
  s.lineTo(1.4, 0.1);
  s.lineTo(1.4, -0.12);
  s.lineTo(1.36, FLOOR);
  if (arches) {
    const a = Math.asin((FLOOR - ARCH_Y) / ARCH_R);
    const dx = Math.cos(a) * ARCH_R;
    s.lineTo(ARCH_X + dx, FLOOR);
    s.absarc(ARCH_X, ARCH_Y, ARCH_R, a, Math.PI - a, false);
    s.lineTo(-ARCH_X + dx, FLOOR);
    s.absarc(-ARCH_X, ARCH_Y, ARCH_R, a, Math.PI - a, false);
  }
  s.lineTo(-1.36, FLOOR);
  s.closePath();
  return s;
}

/** Underbody darkness: ambient-occlusion-like gradient baked into the vertex colours of the paint. */
const shade = (_x: number, y: number) => 0.24 + 0.76 * sstep(-0.19, -0.03, y);

function deformZ(g: BufferGeometry, fn: (x: number, y: number) => number): void {
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) p.setZ(i, p.getZ(i) * fn(p.getX(i), p.getY(i)));
}

/**
 * The cap faces of the side pieces are coarse triangles over a curved (tumblehome) surface; give their vertices the
 * analytic normal of z = W * widthFactor(x, y) so the paint shades smoothly instead of along triangle diagonals.
 */
function smoothCaps(g: BufferGeometry): void {
  const cap = g.groups[0];
  if (!cap) return;
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const e = 1e-3;
  for (let i = cap.start; i < cap.start + cap.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const sg = Math.sign(z);
    if (Math.abs(z) < CORE + 0.05 || nor.getZ(i) * sg < 0.5) continue; // inner caps (hidden) keep theirs
    const zx = (widthFactor(x + e, y) - widthFactor(x - e, y)) / (2 * e);
    const zy = (widthFactor(x, y + e) - widthFactor(x, y - e)) / (2 * e);
    const nx = -W * zx;
    const ny = -W * zy;
    const l = Math.hypot(nx, ny, 1);
    nor.setXYZ(i, nx / l, ny / l, sg / l);
  }
}

/** Paint-coloured lower body: centre tub + two wheel-arched side pieces, tumblehome and taper baked in. */
function lowerBodyGeometry(): BufferGeometry {
  const bt = 0.025;
  const opts = { bevelEnabled: true, bevelThickness: bt, bevelSize: bt, bevelSegments: 3, curveSegments: 16 };
  const parts: BufferGeometry[] = [];

  const coreDepth = CORE * 2 - bt * 2;
  const core = new ExtrudeGeometry(bodyOutline(false), { ...opts, depth: coreDepth });
  core.translate(0, 0, -coreDepth / 2);
  parts.push(core);

  const sideDepth = W - CORE - bt * 2;
  const side = new ExtrudeGeometry(bodyOutline(true), { ...opts, depth: sideDepth });
  side.translate(0, 0, CORE + bt);
  const sideL = side.clone();
  sideL.translate(0, 0, -(W + CORE));
  parts.push(side, sideL);

  const out: BufferGeometry[] = [];
  for (const g of parts) {
    deformZ(g, widthFactor);
    toCreasedNormals(g, 0.75);
    smoothCaps(g);
    const pos = g.attributes.position;
    const col = new Float32Array(pos.count * 3);
    // Wall vertices inside a wheel arch are painted dark (wheelhouse liner).
    const wall = g.groups[1];
    const w0 = wall ? wall.start : pos.count;
    const w1 = wall ? wall.start + wall.count : pos.count;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      let c = shade(x, y);
      if (i >= w0 && i < w1 && g !== core) {
        const d = Math.min(Math.hypot(x - ARCH_X, y - ARCH_Y), Math.hypot(x + ARCH_X, y - ARCH_Y));
        if (d < ARCH_R + 0.04 && Math.abs(pos.getZ(i)) < W * 0.97) c = Math.min(c, 0.1);
      }
      col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = c;
    }
    g.setAttribute('color', new Float32BufferAttribute(col, 3));
    out.push(g);
  }
  const b = new Batch();
  for (const g of out) {
    b.add(g);
    g.dispose();
  }
  return b.bake();
}

function greenhouseGeometry(): BufferGeometry {
  const s = new Shape();
  s.moveTo(0.4, BELT);
  s.lineTo(0.07, ROOF);
  s.lineTo(-0.7, ROOF);
  s.lineTo(-1.0, BELT);
  s.closePath();
  const g = new ExtrudeGeometry(s, { depth: GLASS_W * 2, bevelEnabled: false });
  g.translate(0, 0, -GLASS_W);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) p.setZ(i, (p.getZ(i) / GLASS_W) * glassHalf(p.getY(i)));
  toCreasedNormals(g, 0.6);
  return g;
}

/** Circular segment filling a wheel well on the centre tub (dark liner the suspension is mounted on). */
function wellLinerGeometry(): BufferGeometry {
  const a = Math.asin((FLOOR - ARCH_Y) / ARCH_R);
  const s = new Shape();
  s.absarc(0, 0, ARCH_R + 0.03, a, Math.PI - a, false);
  s.closePath();
  const g = new ExtrudeGeometry(s, { depth: 0.012, bevelEnabled: false, curveSegments: 18 });
  return g;
}

class Helix extends Curve<Vector3> {
  constructor(
    private radius: number,
    private turns: number,
  ) {
    super();
  }
  getPoint(t: number, target = new Vector3()): Vector3 {
    const a = t * this.turns * Math.PI * 2;
    return target.set(Math.cos(a) * this.radius, t, Math.sin(a) * this.radius);
  }
}

interface Slot {
  group: Group;
  rod: Mesh;
  tube: Mesh;
  spring: Mesh;
  armA: Mesh;
  armB: Mesh;
  joint: Mesh;
  caliper: Group;
}

/** Handles for tests and tools (`skin.root.userData.car`). */
export interface CarSkinHandles {
  /** Current strut length (mount to hub) per wheel slot; 0 when the slot has no wheel. */
  strutLength: Float32Array;
  tail: MeshStandardMaterial;
  head: MeshStandardMaterial;
  paint: MeshPhysicalMaterial;
  /** 0..1 smoothed brake-light level. */
  brakeLevel: () => number;
}

const _tq = new Quaternion();
const _wl = new Vector3();
const _ax = new Vector3();
const _col = new Color();

export const carBodySkin: SkinDef = {
  id: 'car.body',
  label: 'Car body (detailed)',
  shapes: ['box'],
  build(_size, spec, def): SkinInstance {
    const lease = new Lease();
    const root = new Group();
    root.name = 'car-body';
    const own: { dispose(): void }[] = [];

    // ── materials ────────────────────────────────────────────────────────────────────────────────────────
    const paintColor = typeof spec.params?.color === 'string' ? spec.params.color : def.material.color;
    const paint = new MeshPhysicalMaterial({
      color: paintColor,
      vertexColors: true,
      metalness: 0.55,
      roughness: 0.32,
      clearcoat: 1,
      clearcoatRoughness: 0.06,
    });
    const tail = new MeshStandardMaterial({
      color: 0x701010,
      emissive: 0xff1a12,
      emissiveIntensity: TAIL_IDLE,
      roughness: 0.25,
    });
    own.push(paint, tail);
    const head = lease.get(
      'car:head',
      () =>
        new MeshStandardMaterial({
          color: 0xfff0cf,
          emissive: 0xffd98a,
          emissiveIntensity: HEAD_INTENSITY,
          roughness: 0.15,
        }),
    );
    const glass = lease.get(
      'car:glass',
      () =>
        new MeshPhysicalMaterial({
          color: 0x07121a,
          metalness: 0,
          roughness: 0.04,
          transparent: true,
          opacity: 0.5,
          side: DoubleSide,
          depthWrite: false,
          clearcoat: 1,
          clearcoatRoughness: 0.02,
          envMapIntensity: 1.6,
        }),
    );
    const chrome = lease.get(
      'car:chrome',
      () => new MeshStandardMaterial({ color: 0xd8dce2, metalness: 1, roughness: 0.18 }),
    );
    const plastic = lease.get(
      'car:plastic',
      () => new MeshStandardMaterial({ color: 0x1b1d21, metalness: 0.1, roughness: 0.62 }),
    );
    const leather = lease.get(
      'car:leather',
      () => new MeshStandardMaterial({ color: 0xb98a5a, metalness: 0, roughness: 0.62 }),
    );
    const trim = lease.get(
      'car:trim',
      () => new MeshStandardMaterial({ color: 0x25272c, metalness: 0.2, roughness: 0.7 }),
    );
    const cluster = lease.get(
      'car:cluster',
      () => new MeshStandardMaterial({ color: 0x0a1a20, emissive: 0x4fd0ff, emissiveIntensity: 1.1, roughness: 0.4 }),
    );
    const plate = lease.get(
      'car:plate',
      () => new MeshStandardMaterial({ color: 0xf1f0e8, metalness: 0, roughness: 0.5 }),
    );
    const steel = lease.get(
      'car:steel',
      () => new MeshStandardMaterial({ color: 0x3a3d44, metalness: 0.8, roughness: 0.45 }),
    );
    const springMat = lease.get(
      'car:spring',
      () => new MeshStandardMaterial({ color: 0xe2461f, metalness: 0.3, roughness: 0.4 }),
    );
    const caliperMat = lease.get(
      'car:caliper',
      () => new MeshStandardMaterial({ color: 0xe6b422, metalness: 0.4, roughness: 0.35 }),
    );

    const add = (g: BufferGeometry, m: MeshStandardMaterial, shadow = true, receive = true): Mesh => {
      const mesh = new Mesh(g, m);
      mesh.castShadow = shadow;
      mesh.receiveShadow = receive;
      mesh.userData.skinPart = true;
      root.add(mesh);
      return mesh;
    };

    // ── static geometry (shared between cars) ───────────────────────────────────────────────────────────
    const paintGeo = lease.get('car:paintGeo', () => {
      const b = new Batch(shade);
      const lower = lowerBodyGeometry();
      b.add(lower);
      lower.dispose();
      const rb = (w: number, h: number, d: number, r: number) => new RoundedBoxGeometry(w, h, d, 1, r);
      // roof panel and headers
      const roof = rb(0.82, 0.045, 1.0, 0.02);
      b.add(roof, tm(-0.315, ROOF + 0.012, 0));
      roof.dispose();
      const header = rb(0.06, 0.05, 1.0, 0.02);
      b.add(header, tm(0.1, ROOF - 0.012, 0, 0, 0, 0.55));
      b.add(header, tm(-0.74, ROOF - 0.012, 0, 0, 0, -0.62));
      header.dispose();
      for (const s of [-1, 1]) {
        // pillars: A (windscreen), B, C (rear quarter)
        const pil = new RoundedBoxGeometry(1, 1, 1, 1, 0.15);
        const zA0 = glassHalf(BELT) + 0.012;
        const zA1 = glassHalf(ROOF) + 0.012;
        b.add(
          pil,
          segment(0.4, BELT, s * zA0, 0.07, ROOF, s * zA1, 0.05, 0.055).multiply(tm(0, 0.5, 0, 0, 0, 0, 1, 1, 1)),
        );
        b.add(
          pil,
          segment(-0.3, BELT, s * zA0, -0.34, ROOF, s * zA1, 0.075, 0.05).multiply(tm(0, 0.5, 0, 0, 0, 0, 1, 1, 1)),
        );
        b.add(
          pil,
          segment(-1.0, BELT, s * zA0, -0.7, ROOF, s * zA1, 0.1, 0.07).multiply(tm(0, 0.5, 0, 0, 0, 0, 1, 1, 1)),
        );
        pil.dispose();
        // door mirrors
        const stalk = rb(0.04, 0.03, 0.1, 0.01);
        b.add(stalk, tm(0.27, 0.355, s * 0.74));
        stalk.dispose();
        const mir = rb(0.09, 0.075, 0.045, 0.02);
        b.add(mir, tm(0.25, 0.385, s * 0.8, 0, s * 0.12, 0));
        mir.dispose();
      }
      // duck-tail spoiler
      const sp = rb(0.2, 0.025, 1.04, 0.01);
      b.add(sp, tm(-1.3, 0.335, 0, 0, 0, 0.12));
      sp.dispose();
      // hood bulge
      const bulge = rb(0.6, 0.03, 0.36, 0.015);
      b.add(bulge, tm(0.78, 0.305, 0, 0, 0, -0.05));
      bulge.dispose();
      return b.bake();
    });
    add(paintGeo, paint);

    const glassGeo = lease.get('car:glassGeo', greenhouseGeometry);
    add(glassGeo, glass, false, false).renderOrder = 2;

    const chromeGeo = lease.get('car:chromeGeo', () => {
      const b = new Batch();
      const rb = (w: number, h: number, d: number, r: number) => new RoundedBoxGeometry(w, h, d, 1, r);
      // grille slats and badge
      const slat = rb(0.012, 0.012, 0.4, 0.004);
      for (let i = 0; i < 4; i++) b.add(slat, tm(1.457, 0.036 + i * 0.026, 0));
      slat.dispose();
      const badge = new CylinderGeometry(0.03, 0.03, 0.01, 20);
      b.add(badge, tm(1.458, 0.125, 0, 0, 0, Math.PI / 2));
      badge.dispose();
      // exhaust tips
      const tip = new CylinderGeometry(0.032, 0.032, 0.12, 18);
      for (const z of [-0.38, 0.38]) b.add(tip, tm(-1.44, -0.13, z, 0, 0, Math.PI / 2));
      tip.dispose();
      // door handles
      const handle = rb(0.12, 0.02, 0.025, 0.008);
      for (const s of [-1, 1]) {
        b.add(handle, tm(0.1, 0.235, s * (surfaceZ(0.1, 0.235) + 0.012)));
        b.add(handle, tm(-0.55, 0.235, s * (surfaceZ(-0.55, 0.235) + 0.012)));
        // window sills
        const sill = rb(1.4, 0.014, 0.022, 0.006);
        b.add(sill, tm(-0.3, BELT + 0.012, s * (glassHalf(BELT) + 0.005)));
        sill.dispose();
      }
      handle.dispose();
      return b.bake();
    });
    add(chromeGeo, chrome, false);

    const plasticGeo = lease.get('car:plasticGeo', () => {
      const b = new Batch();
      const rb = (w: number, h: number, d: number, r: number) => new RoundedBoxGeometry(w, h, d, 1, r);
      // bumpers / valances, air intakes, diffuser
      const front = rb(0.14, 0.17, 1.14, 0.05);
      b.add(front, tm(1.4, -0.09, 0));
      b.add(front, tm(-1.4, -0.09, 0));
      front.dispose();
      const grille = rb(0.05, 0.11, 0.46, 0.015);
      b.add(grille, tm(1.425, 0.07, 0));
      grille.dispose();
      // headlight housings, taillight housings
      const hh = rb(0.06, 0.1, 0.25, 0.02);
      for (const z of [-0.46, 0.46]) {
        b.add(hh, tm(1.345, 0.165, z, 0, -0.12 * Math.sign(z), 0));
        b.add(hh, tm(-1.385, 0.17, z * 0.92, 0, 0.1 * Math.sign(z), 0));
      }
      hh.dispose();
      // door shut lines
      const line = rb(0.008, 1, 0.01, 0.003);
      for (const s of [-1, 1]) {
        for (const x of [0.38, -0.3, -0.93]) {
          const z0 = s * (surfaceZ(x, -0.13) + 0.003);
          const z1 = s * (surfaceZ(x, 0.29) + 0.003);
          b.add(line, segment(x, -0.13, z0, x, 0.29, z1, 1, 1));
        }
        const z = (x: number) => s * (surfaceZ(x, -0.13) + 0.003);
        b.add(line, segment(-0.93, -0.13, z(-0.93), 0.38, -0.13, z(0.38), 1, 1));
        // wheel-well flares
        const flare = new TorusGeometry(ARCH_R + 0.012, 0.014, 6, 32, Math.PI * 0.85);
        for (const wx of [-ARCH_X, ARCH_X])
          b.add(flare, tm(wx, ARCH_Y, s * (surfaceZ(wx, 0.1) + 0.0), 0, 0, Math.PI * 0.075));
        flare.dispose();
      }
      line.dispose();
      // window rubber under the roof header
      const wip = rb(0.01, 0.012, 0.5, 0.004);
      b.add(wip, tm(0.37, BELT + 0.02, 0.2, 0, 0, 0.5));
      b.add(wip, tm(0.37, BELT + 0.02, -0.2, 0, 0, 0.5));
      wip.dispose();
      // rear plate recess, antenna
      const ant = new CylinderGeometry(0.004, 0.006, 0.2, 6);
      b.add(ant, tm(-0.62, ROOF + 0.12, 0.3, 0, 0, 0.18));
      ant.dispose();
      return b.bake();
    });
    add(plasticGeo, plastic);

    const linerGeo = lease.get('car:linerGeo', () => {
      const b = new Batch();
      const g = wellLinerGeometry();
      for (const s of [-1, 1])
        for (const x of [-ARCH_X, ARCH_X]) b.add(g, tm(x, ARCH_Y, s > 0 ? CORE + 0.001 : -CORE - 0.013));
      g.dispose();
      return b.bake();
    });
    add(linerGeo, trim, false);

    const plateGeo = lease.get('car:plateGeo', () => {
      const b = new Batch();
      const p = new RoundedBoxGeometry(0.012, 0.075, 0.2, 2, 0.004);
      b.add(p, tm(1.478, -0.1, 0));
      b.add(p, tm(-1.478, -0.075, 0));
      p.dispose();
      return b.bake();
    });
    add(plateGeo, plate, false);

    // interior ──────────────────────────────────────────────────────────────────────────────────────────
    const seatGeo = lease.get('car:seatGeo', () => {
      const b = new Batch();
      const rb = (w: number, h: number, d: number, r: number) => new RoundedBoxGeometry(w, h, d, 2, r);
      const cushion = rb(0.38, 0.1, 0.34, 0.035);
      const back = rb(0.09, 0.44, 0.34, 0.035);
      const headrest = rb(0.07, 0.12, 0.2, 0.03);
      for (const z of [-0.24, 0.24]) {
        b.add(cushion, tm(-0.1, BELT + 0.05, z));
        b.add(back, tm(-0.31, BELT + 0.25, z, 0, 0, 0.2));
        b.add(headrest, tm(-0.37, BELT + 0.5, z, 0, 0, 0.2));
      }
      const bench = rb(0.4, 0.1, 0.96, 0.035);
      const bback = rb(0.09, 0.4, 0.96, 0.035);
      b.add(bench, tm(-0.62, BELT + 0.05, 0));
      b.add(bback, tm(-0.82, BELT + 0.22, 0, 0, 0, 0.2));
      cushion.dispose();
      back.dispose();
      headrest.dispose();
      bench.dispose();
      bback.dispose();
      return b.bake();
    });
    add(seatGeo, leather, false);

    const trimGeo = lease.get('car:trimGeo', () => {
      const b = new Batch();
      const rb = (w: number, h: number, d: number, r: number) => new RoundedBoxGeometry(w, h, d, 1, r);
      const floor = rb(1.4, 0.02, 1.0, 0.008);
      b.add(floor, tm(-0.3, BELT + 0.005, 0));
      floor.dispose();
      // dashboard, instrument hood, centre console
      const dash = rb(0.22, 0.1, 1.08, 0.04);
      b.add(dash, tm(0.27, BELT + 0.07, 0, 0, 0, -0.1));
      dash.dispose();
      const hood = rb(0.12, 0.055, 0.34, 0.02);
      b.add(hood, tm(0.19, BELT + 0.14, -0.25));
      hood.dispose();
      const console = rb(0.46, 0.08, 0.12, 0.03);
      b.add(console, tm(-0.1, BELT + 0.08, 0));
      console.dispose();
      // rear shelf + door cards
      const shelf = rb(0.16, 0.025, 1.0, 0.01);
      b.add(shelf, tm(-0.95, BELT + 0.1, 0));
      shelf.dispose();
      // steering column and wheel spokes + hub
      b.add(new CylinderGeometry(0.018, 0.018, 0.22, 10), tm(0.22, BELT + 0.1, -0.25, 0, 0, 1.1));
      const sw = tm(0.16, 0.5, -0.25, 0, -Math.PI / 2, 0).multiply(tm(0, 0, 0, -0.38, 0, 0));
      const swRim = new TorusGeometry(0.105, 0.0125, 8, 28);
      b.add(swRim, sw);
      swRim.dispose();
      const spokeG = rb(0.2, 0.014, 0.012, 0.004);
      b.add(spokeG, sw);
      b.add(rb(0.014, 0.1, 0.012, 0.004), sw.clone().multiply(tm(0, -0.05, 0)));
      spokeG.dispose();
      const hub = new CylinderGeometry(0.03, 0.03, 0.03, 14);
      b.add(hub, sw.clone().multiply(tm(0, 0, 0, Math.PI / 2, 0, 0)));
      hub.dispose();
      // rear-view mirror
      const rv = rb(0.025, 0.04, 0.2, 0.01);
      b.add(rv, tm(0.12, ROOF - 0.07, 0));
      rv.dispose();
      return b.bake();
    });
    add(trimGeo, trim, false);

    const clusterGeo = lease.get('car:clusterGeo', () => {
      const g = new PlaneGeometry(0.3, 0.075);
      g.rotateY(-Math.PI / 2);
      g.translate(0.133, BELT + 0.135, -0.25);
      return g;
    });
    add(clusterGeo, cluster, false, false);

    const lensGeo = lease.get('car:lensGeo', () => {
      const b = new Batch();
      const s = new SphereGeometry(1, 20, 12);
      for (const z of [-0.46, 0.46]) b.add(s, tm(1.378, 0.165, z, 0, -0.12 * Math.sign(z), 0, 0.045, 0.062, 0.115));
      s.dispose();
      return b.bake();
    });
    add(lensGeo, head, false, false);

    const tailGeo = lease.get('car:tailGeo', () => {
      const b = new Batch();
      const rb = (w: number, h: number, d: number, r: number) => new RoundedBoxGeometry(w, h, d, 1, r);
      const lamp = rb(0.04, 0.075, 0.27, 0.02);
      for (const z of [-0.43, 0.43]) b.add(lamp, tm(-1.412, 0.172, z, 0, 0.1 * Math.sign(z), 0));
      lamp.dispose();
      const bar = rb(0.018, 0.022, 0.5, 0.008);
      b.add(bar, tm(-1.418, 0.2, 0));
      bar.dispose();
      return b.bake();
    });
    add(tailGeo, tail, false, false);

    // ── suspension assemblies (dynamic) ─────────────────────────────────────────────────────────────────
    const unitCyl = (r: number, seg: number, key: string) =>
      lease.get(key, () => {
        const g = new CylinderGeometry(r, r, 1, seg, 1);
        g.translate(0, 0.5, 0);
        return g;
      });
    const rodGeo = unitCyl(0.0105, 8, 'car:rod');
    const tubeGeo = unitCyl(0.024, 12, 'car:tube');
    const armGeo = unitCyl(0.0125, 8, 'car:arm');
    const springGeo = lease.get('car:springGeo', () => {
      const g = new TubeGeometry(new Helix(0.043, 6), 60, 0.0085, 5, false);
      return g;
    });
    const jointGeo = lease.get('car:jointGeo', () => new SphereGeometry(0.028, 12, 8));
    const caliperGeo = lease.get('car:caliperGeo', () => {
      const b = new Batch();
      const body = new RoundedBoxGeometry(0.12, 0.085, 0.052, 2, 0.015);
      b.add(body);
      body.dispose();
      return b.bake();
    });

    const mesh = (g: BufferGeometry, m: MeshStandardMaterial): Mesh => {
      const x = new Mesh(g, m);
      x.castShadow = true;
      x.frustumCulled = false; // placed every frame from outside the geometry's own bounds
      return x;
    };
    const slots: Slot[] = [];
    for (let i = 0; i < MAX_WHEELS; i++) {
      const group = new Group();
      group.name = `suspension-${i}`;
      const rod = mesh(rodGeo, chrome);
      const tube = mesh(tubeGeo, steel);
      const spring = mesh(springGeo, springMat);
      const armA = mesh(armGeo, steel);
      const armB = mesh(armGeo, steel);
      const joint = mesh(jointGeo, steel);
      const caliper = new Group();
      const calMesh = mesh(caliperGeo, caliperMat);
      calMesh.frustumCulled = true;
      caliper.add(calMesh);
      group.add(rod, tube, spring, armA, armB, joint, caliper);
      group.visible = false;
      root.add(group);
      slots.push({ group, rod, tube, spring, armA, armB, joint, caliper });
    }
    // Calipers sit behind the spokes at the top of the disc; offset set per side in update.

    const handles: CarSkinHandles = {
      strutLength: new Float32Array(MAX_WHEELS),
      tail,
      head,
      paint,
      brakeLevel: () => level,
    };
    root.userData.car = handles;

    let level = 0;
    const selfId = def.id;
    let colorKey = paintColor;

    function update(frame: SkinFrame): void {
      // Tail-lights: dim always, full brightness while the brake / reverse key is held (smoothed).
      const target = frame.keys.has(BRAKE_KEY) ? 1 : 0;
      level += (target - level) * (1 - Math.exp(-16 * Math.max(0, frame.dt)));
      if (Math.abs(target - level) < 0.002) level = target;
      tail.emissiveIntensity = TAIL_IDLE + (TAIL_BRAKE - TAIL_IDLE) * level;

      // Paint follows the chassis body's live material colour (set `params.color` to pin a colour instead).
      if (typeof spec.params?.color !== 'string') {
        const me = frame.bodiesWithTag(CAR_BODY_TAG);
        for (let i = 0; i < me.length; i++) {
          if (me[i].def.id !== selfId) continue;
          const c = me[i].def.material.color;
          if (c !== colorKey) {
            colorKey = c;
            paint.color.set(_col.set(c));
          }
          break;
        }
      }

      // Suspension from the wheel bodies' poses, in the chassis frame.
      const wheels = frame.bodiesWithTag(CAR_WHEEL_TAG);
      _tq.copy(frame.quaternion).invert();
      let slot = 0;
      for (let i = 0; i < wheels.length && slot < MAX_WHEELS; i++) {
        const w = wheels[i];
        _wl.copy(w.position).sub(frame.position).applyQuaternion(_tq);
        if (_wl.lengthSq() > 6.25) continue; // a wheel of another car
        const s = _wl.z < 0 ? -1 : 1;
        const sl = slots[slot];
        sl.group.visible = true;
        const x = _wl.x;
        const hy = _wl.y;
        const zs = s * 0.56;
        const my = 0.13;
        const len = stretch(sl.rod, x, hy, zs, x, my, zs);
        const dx = 0;
        const dy = len > 1e-6 ? (my - hy) / len : 1;
        stretch(sl.tube, x, hy, zs, x + dx, hy + dy * Math.min(0.17, len * 0.62), zs);
        stretch(sl.spring, x, hy + dy * 0.03, zs, x, my - dy * 0.02, zs);
        const ay = -0.1;
        const hz = s * 0.6;
        stretch(sl.armA, x - 0.18, ay, s * 0.43, x, hy, hz);
        stretch(sl.armB, x + 0.18, ay, s * 0.43, x, hy, hz);
        sl.joint.position.set(x, hy, hz);
        handles.strutLength[slot] = len;

        // Brake caliper: follows the hub and the steering, never the spin.
        _ax.set(0, 1, 0).applyQuaternion(w.quaternion).applyQuaternion(_tq);
        const sg = _ax.z < 0 ? -1 : 1;
        sl.caliper.position.set(x, hy, _wl.z);
        sl.caliper.rotation.y = Math.atan2(_ax.x * sg, _ax.z * sg);
        const cal = sl.caliper.children[0];
        cal.position.set(-0.08, 0.125, -s * 0.022);
        slot++;
      }
      for (; slot < MAX_WHEELS; slot++) {
        slots[slot].group.visible = false;
        handles.strutLength[slot] = 0;
      }
    }

    return {
      root,
      update,
      dispose() {
        root.clear();
        for (const o of own) o.dispose();
        lease.release();
      },
    };
  },
};

export const CAR_SKINS: SkinDef[] = [carBodySkin, carWheelSkin];
