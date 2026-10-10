/**
 * Draws the plan of `componentFxPlan.ts`: exhaust flames, spinning blades that fade into a blur, and the small gauges
 * (angle dial, stroke slide, brake ring) of the powered parts. Objects are pooled by component id and reused every
 * frame; the ones no longer in the plan are removed. Nothing here touches the physics: it only reads.
 */
import {
  AdditiveBlending,
  BoxGeometry,
  BufferGeometry,
  CircleGeometry,
  Color,
  ConeGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import { clamp } from '../core/math';
import type { DialFx, DiscFx, FlameFx, Fx, FxSource, RingFx, SlideFx } from './componentFxPlan';
import { planComponentFx } from './componentFxPlan';

const UP = new Vector3(0, 1, 0);
const FRONT = new Vector3(0, 0, 1);
const tmp = new Vector3();
const tmp2 = new Vector3();
const tmp3 = new Vector3();
const WHITE = new Color('#ffffff');
const basis = new Matrix4();

const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** One drawn thing; `apply` moves it to match the plan item. */
interface View<T extends Fx> {
  readonly kind: T['kind'];
  readonly root: Object3D;
  apply(fx: T, dt: number, time: number): void;
  dispose(): void;
}

const overlayMaterial = (color: string | number, opacity = 1) =>
  new MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false });

// ── flame ─────────────────────────────────────────────────────────────────────────────────────────

const FLAME_CONE = new ConeGeometry(1, 1, 20, 1, true).translate(0, 0.5, 0); // base at the origin, tip at +y

class FlameView implements View<FlameFx> {
  readonly kind = 'flame' as const;
  readonly root = new Group();
  private readonly layers: { mesh: Mesh; sx: number; sy: number; alpha: number }[] = [];
  private readonly seed = Math.random() * 100;
  private readonly tint = new Color();

  constructor() {
    for (const [sx, sy, alpha] of [
      [1, 1, 0.28],
      [0.62, 0.78, 0.42],
      [0.3, 0.55, 0.75],
    ] as const) {
      const mesh = new Mesh(
        FLAME_CONE,
        new MeshBasicMaterial({
          transparent: true,
          opacity: alpha,
          blending: AdditiveBlending,
          depthWrite: false,
          side: DoubleSide,
        }),
      );
      mesh.renderOrder = 990;
      this.layers.push({ mesh, sx, sy, alpha });
      this.root.add(mesh);
    }
  }

  apply(fx: FlameFx, _dt: number, time: number): void {
    this.root.position.set(fx.at[0], fx.at[1], fx.at[2]);
    this.root.quaternion.setFromUnitVectors(UP, tmp.set(fx.dir[0], fx.dir[1], fx.dir[2]).normalize());
    const t = time + this.seed;
    const flicker = 1 + 0.07 * Math.sin(t * 53) + 0.05 * Math.sin(t * 97 + 1.7) + 0.03 * Math.sin(t * 181);
    const wobble = 1 + 0.05 * Math.sin(t * 71 + 0.4);
    const k = clamp(fx.intensity, 0, 1.2);
    const fade = fx.preview ? 0.35 : 1;
    this.layers.forEach((l, i) => {
      const w = fx.width * l.sx * wobble * (0.55 + 0.45 * Math.min(1, k));
      l.mesh.scale.set(w, Math.max(0.001, fx.length * l.sy * flicker), w);
      const m = l.mesh.material as MeshBasicMaterial;
      this.tint.set(fx.color);
      if (i === 1) this.tint.lerp(WHITE, 0.45);
      if (i === 2) this.tint.set(fx.afterburner ? '#ffe2b8' : '#ffffff');
      m.color.copy(this.tint);
      m.opacity = l.alpha * Math.min(1, 0.35 + k) * fade;
    });
  }

  dispose(): void {
    for (const l of this.layers) (l.mesh.material as MeshBasicMaterial).dispose();
  }
}

// ── blades and blur ───────────────────────────────────────────────────────────────────────────────

const BLADE = new BoxGeometry(1, 0.012, 0.09).translate(0.5, 0, 0); // unit length from the hub
const DISC = new CircleGeometry(1, 56).rotateX(-Math.PI / 2); // in the XZ plane, normal +y

class DiscView implements View<DiscFx> {
  readonly kind = 'disc' as const;
  readonly root = new Group();
  private readonly blur: Mesh;
  private readonly blades = new Group();
  private readonly bladeMat = new MeshBasicMaterial({ transparent: true, depthWrite: false });
  private readonly blurMat = new MeshBasicMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
  });
  private count = 0;
  private phase = 0;

  constructor() {
    this.blur = new Mesh(DISC, this.blurMat);
    this.blur.renderOrder = 989;
    this.root.add(this.blur, this.blades);
  }

  apply(fx: DiscFx, dt: number): void {
    this.root.position.set(fx.at[0], fx.at[1], fx.at[2]);
    this.root.quaternion.setFromUnitVectors(UP, tmp.set(fx.axis[0], fx.axis[1], fx.axis[2]).normalize());
    this.root.scale.setScalar(Math.max(0.01, fx.radius));
    if (fx.blades !== this.count) {
      this.count = fx.blades;
      this.blades.clear();
      for (let i = 0; i < fx.blades; i++) {
        const blade = new Mesh(BLADE, this.bladeMat);
        blade.rotation.y = (i / fx.blades) * Math.PI * 2;
        blade.renderOrder = 991;
        this.blades.add(blade);
      }
    }
    const rpm = Math.abs(fx.rpm);
    // the angle the blades are drawn at: the real speed is far above what a screen can show, so the blades are on
    // screen only while they are slow, and the disc takes over (a stroboscope would only be confusing)
    this.phase = (this.phase + (fx.rpm / 60) * Math.PI * 2 * dt) % (Math.PI * 2);
    this.blades.rotation.y = this.phase;
    this.bladeMat.color.set(fx.color);
    this.blurMat.color.set(fx.color);
    const blur = smooth(30, 520, rpm);
    this.bladeMat.opacity = fx.preview ? 0.55 : 1 - 0.92 * smooth(90, 700, rpm);
    this.blurMat.opacity = fx.preview ? 0.08 : 0.34 * blur;
    this.blur.visible = this.blurMat.opacity > 0.01;
    this.blades.visible = this.bladeMat.opacity > 0.02;
  }

  dispose(): void {
    this.bladeMat.dispose();
    this.blurMat.dispose();
  }
}

// ── dial (servo / stepper) ────────────────────────────────────────────────────────────────────────

const GAUGE_CYAN = '#3ddcff';
const GAUGE_AMBER = '#ffb347';
const GAUGE_DIM = '#5b6a82';
const NEEDLE = new BoxGeometry(1, 0.014, 0.014).translate(0.5, 0, 0);
const DOT = new SphereGeometry(1, 14, 10);

function lineOf(points: number[], color: string, opacity: number): Line {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(points, 3));
  const l = new Line(
    g,
    new LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false }),
  );
  l.renderOrder = 998;
  return l;
}

/** Points of the arc from angle a to b about +y (the dial's local axis), 0 at +x, positive angle turning toward −z. */
function arcPoints(a: number, b: number, r: number): number[] {
  const n = Math.max(2, Math.ceil(Math.abs(b - a) / (Math.PI / 24)));
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = a + ((b - a) * i) / n;
    out.push(Math.cos(t) * r, 0, -Math.sin(t) * r);
  }
  return out;
}

class DialView implements View<DialFx> {
  readonly kind = 'dial' as const;
  readonly root = new Group();
  private readonly needle: Object3D = new Object3D();
  private readonly target: Object3D = new Object3D();
  private readonly mats: { dispose(): void }[] = [];
  private travel: Line | null = null;
  private rim: Line | null = null;
  private signature = '';

  constructor() {
    const needleMat = overlayMaterial(GAUGE_CYAN, 0.95);
    const hub = new Mesh(DOT, needleMat);
    hub.scale.setScalar(0.03);
    const blade = new Mesh(NEEDLE, needleMat);
    blade.renderOrder = 999;
    hub.renderOrder = 999;
    this.needle.add(blade);
    this.root.add(hub, this.needle);
    const targetMat = overlayMaterial(GAUGE_AMBER, 0.95);
    const tip = new Mesh(DOT, targetMat);
    tip.scale.setScalar(0.035);
    tip.renderOrder = 999;
    this.target.add(tip);
    this.root.add(this.target);
    this.mats.push(needleMat, targetMat);
  }

  apply(fx: DialFx): void {
    this.root.position.set(fx.at[0], fx.at[1], fx.at[2]);
    // local frame: +x = angle zero, +y = the axis, +z = x × y
    const x = tmp.set(fx.ref[0], fx.ref[1], fx.ref[2]).normalize();
    const y = tmp2.set(fx.axis[0], fx.axis[1], fx.axis[2]).normalize();
    const z = tmp3.crossVectors(x, y);
    basis.makeBasis(x, y, z);
    this.root.quaternion.setFromRotationMatrix(basis);
    const sig = `${fx.radius}|${fx.min}|${fx.max}`;
    if (sig !== this.signature) {
      this.signature = sig;
      for (const l of [this.rim, this.travel]) {
        if (l) {
          this.root.remove(l);
          l.geometry.dispose();
          (l.material as LineBasicMaterial).dispose();
        }
      }
      this.rim = lineOf(arcPoints(0, Math.PI * 2, fx.radius), GAUGE_DIM, 0.45);
      this.root.add(this.rim);
      this.travel = null;
      if (fx.min !== null && fx.max !== null && fx.max > fx.min) {
        this.travel = lineOf(arcPoints(fx.min, fx.max, fx.radius * 1.06), GAUGE_CYAN, 0.8);
        this.root.add(this.travel);
      }
    }
    this.needle.scale.set(fx.radius, 1, 1);
    this.needle.rotation.y = fx.current;
    this.target.visible = fx.target !== null;
    if (fx.target !== null) {
      this.target.rotation.y = fx.target;
      this.target.children[0].position.set(fx.radius, 0, 0);
    }
  }

  dispose(): void {
    for (const m of this.mats) m.dispose();
    for (const l of [this.rim, this.travel]) {
      l?.geometry.dispose();
      (l?.material as LineBasicMaterial | undefined)?.dispose();
    }
  }
}

// ── slide (linear actuator / hydraulic cylinder) ──────────────────────────────────────────────────

class SlideView implements View<SlideFx> {
  readonly kind = 'slide' as const;
  readonly root = new Group();
  private readonly current: Mesh;
  private readonly target: Mesh;
  private track: Line | null = null;
  private readonly mats: MeshBasicMaterial[] = [];
  private signature = '';

  constructor() {
    const a = overlayMaterial(GAUGE_CYAN, 0.95);
    const b = overlayMaterial(GAUGE_AMBER, 0.95);
    this.mats.push(a, b);
    this.current = new Mesh(DOT, a);
    this.current.scale.setScalar(0.06);
    this.target = new Mesh(DOT, b);
    this.target.scale.setScalar(0.045);
    this.current.renderOrder = this.target.renderOrder = 999;
    this.root.add(this.current, this.target);
  }

  apply(fx: SlideFx): void {
    this.root.position.set(fx.at[0], fx.at[1], fx.at[2]);
    this.root.quaternion.setFromUnitVectors(UP, tmp.set(fx.axis[0], fx.axis[1], fx.axis[2]).normalize());
    const sig = `${fx.min}|${fx.max}`;
    if (sig !== this.signature) {
      this.signature = sig;
      if (this.track) {
        this.root.remove(this.track);
        this.track.geometry.dispose();
        (this.track.material as LineBasicMaterial).dispose();
      }
      const t = 0.07;
      this.track = lineOf(
        [-t, fx.min, 0, t, fx.min, 0, 0, fx.min, 0, 0, fx.max, 0, -t, fx.max, 0, t, fx.max, 0],
        GAUGE_CYAN,
        0.8,
      );
      this.root.add(this.track);
    }
    this.current.position.set(0, fx.current, 0);
    this.target.visible = fx.target !== null;
    if (fx.target !== null) this.target.position.set(0, clamp(fx.target, fx.min, fx.max), 0);
  }

  dispose(): void {
    for (const m of this.mats) m.dispose();
    this.track?.geometry.dispose();
    (this.track?.material as LineBasicMaterial | undefined)?.dispose();
  }
}

// ── brake ring ────────────────────────────────────────────────────────────────────────────────────

const RING = new TorusGeometry(1, 0.1, 10, 48);
const COLD = new Color('#4a5b78');
const HOT = new Color('#ff5a3c');

class RingView implements View<RingFx> {
  readonly kind = 'ring' as const;
  readonly root = new Group();
  private readonly mat = overlayMaterial('#ffffff', 0.5);
  private readonly mesh = new Mesh(RING, this.mat);

  constructor() {
    this.mesh.renderOrder = 997;
    this.root.add(this.mesh);
  }

  apply(fx: RingFx): void {
    this.root.position.set(fx.at[0], fx.at[1], fx.at[2]);
    this.root.quaternion.setFromUnitVectors(FRONT, tmp.set(fx.axis[0], fx.axis[1], fx.axis[2]).normalize());
    this.mesh.scale.setScalar(fx.radius);
    this.mat.color.copy(COLD).lerp(HOT, fx.heat);
    this.mat.opacity = 0.3 + 0.65 * fx.heat;
  }

  dispose(): void {
    this.mat.dispose();
  }
}

// ── the pool ──────────────────────────────────────────────────────────────────────────────────────

type AnyView = View<FlameFx> | View<DiscFx> | View<DialFx> | View<SlideFx> | View<RingFx>;

function create(kind: Fx['kind']): AnyView {
  switch (kind) {
    case 'flame':
      return new FlameView();
    case 'disc':
      return new DiscView();
    case 'dial':
      return new DialView();
    case 'slide':
      return new SlideView();
    case 'ring':
      return new RingView();
  }
}

function applyTo(view: AnyView, fx: Fx, dt: number, time: number): void {
  // the pool is keyed by kind, so the view and the plan item always agree
  (view as unknown as View<Fx>).apply(fx, dt, time);
}

export class ComponentFx {
  readonly group = new Group();
  private readonly views = new Map<string, AnyView>();
  private time = 0;

  constructor(
    parent: Group,
    private readonly source: FxSource,
  ) {
    this.group.name = 'component-fx';
    parent.add(this.group);
  }

  /** Number of things currently drawn (for tests and the status line). */
  get count(): number {
    return this.views.size;
  }

  update(dt: number): void {
    this.time += dt;
    const plan = planComponentFx(this.source);
    const seen = new Set<string>();
    for (const fx of plan) {
      const key = `${fx.kind}:${fx.key}`;
      seen.add(key);
      let view = this.views.get(key);
      if (!view) {
        view = create(fx.kind);
        this.views.set(key, view);
        this.group.add(view.root);
      }
      applyTo(view, fx, dt, this.time);
    }
    for (const [key, view] of this.views) {
      if (seen.has(key)) continue;
      this.group.remove(view.root);
      view.dispose();
      this.views.delete(key);
    }
  }

  dispose(): void {
    for (const view of this.views.values()) view.dispose();
    this.views.clear();
    this.group.removeFromParent();
  }
}
