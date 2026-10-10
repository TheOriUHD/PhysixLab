/**
 * Pointer behaviour of the interaction tools of package ED-B: blast variants (ED-40), throw / aim (ED-44), paint
 * (ED-42) and pin (ED-43). `InputController` hands the press over (`blastDown`, `throwDown` …); a tool that keeps
 * going after the press (a held gust, a charging throw, a paint stroke) installs a custom gesture for move / up.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  type Vector3,
} from 'three';
import { vlen, vsub, type Vec3 } from '../core/math';
import { materialFromPreset } from '../model/materials';
import { isBody, isSoft } from '../model/types';
import type { App } from './app';
import type { InputController } from './input';
import { chargePower } from './projectiles';
import { predictFlight } from './trajectory';

const GUST_TICK_MS = 50;
/** Point budget of the aim line: 6 s of flight at up to 240 Hz (longer paths are cut off). */
const MAX_AIM_POINTS = 6 * 240 + 2;

/** Aim arrow + predicted path + landing ring, owned by one throw gesture and disposed with it. */
class AimPreview {
  private line: Line;
  private pos = new Float32Array(MAX_AIM_POINTS * 3);
  private ring: Mesh;
  private arrow: Line;
  private arrowPos = new Float32Array(6);

  constructor(private app: App) {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(this.pos, 3));
    g.setDrawRange(0, 0);
    this.line = new Line(
      g,
      new LineBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.95, depthTest: false }),
    );
    this.line.frustumCulled = false;
    this.line.renderOrder = 997;
    const ag = new BufferGeometry();
    ag.setAttribute('position', new BufferAttribute(this.arrowPos, 3));
    this.arrow = new Line(ag, new LineBasicMaterial({ color: 0x3ddcff, depthTest: false }));
    this.arrow.frustumCulled = false;
    this.arrow.renderOrder = 998;
    this.ring = new Mesh(
      new RingGeometry(0.35, 0.5, 40).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({
        color: 0xffb347,
        transparent: true,
        opacity: 0.85,
        side: DoubleSide,
        depthTest: false,
        blending: AdditiveBlending,
      }),
    );
    this.ring.renderOrder = 997;
    this.ring.visible = false;
    app.viewport.scene.add(this.line, this.arrow, this.ring);
  }

  /** Redraw for a shot from `origin` along `dir` at `power`× charge. Returns the flight time / landing distance for the label. */
  update(origin: Vector3, dir: Vector3, power: number): { speed: number; range: number | null; time: number } {
    const app = this.app;
    const setup = app.shotSetup(power);
    const start: Vec3 = [origin.x + dir.x * 1.2, origin.y + dir.y * 1.2, origin.z + dir.z * 1.2];
    const flight = predictFlight({
      origin: start,
      velocity: [dir.x * setup.speed, dir.y * setup.speed, dir.z * setup.speed],
      gravity: app.store.settings.gravity,
      gravityScale: setup.gravityScale,
      damping: setup.damping,
      floorY: app.store.settings.ground.enabled ? 0 : null,
      dt: 1 / app.store.settings.physicsHz,
    });
    const n = Math.min(flight.points.length / 3, MAX_AIM_POINTS);
    this.pos.set(flight.points.slice(0, n * 3));
    const attr = this.line.geometry.getAttribute('position') as BufferAttribute;
    attr.needsUpdate = true;
    this.line.geometry.setDrawRange(0, n);
    // The arrow is the launch direction, longer with more charge.
    const len = 1 + 2 * (power - 1);
    this.arrowPos.set([
      start[0],
      start[1],
      start[2],
      start[0] + dir.x * len,
      start[1] + dir.y * len,
      start[2] + dir.z * len,
    ]);
    (this.arrow.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    if (flight.landing) {
      this.ring.visible = true;
      this.ring.position.set(flight.landing[0], flight.landing[1] + 0.02, flight.landing[2]);
    } else this.ring.visible = false;
    const range = flight.landing ? Math.hypot(flight.landing[0] - start[0], flight.landing[2] - start[2]) : null;
    return { speed: setup.speed, range, time: flight.time };
  }

  dispose(): void {
    this.app.viewport.scene.remove(this.line, this.arrow, this.ring);
    this.line.geometry.dispose();
    (this.line.material as LineBasicMaterial).dispose();
    this.arrow.geometry.dispose();
    (this.arrow.material as LineBasicMaterial).dispose();
    this.ring.geometry.dispose();
    (this.ring.material as MeshBasicMaterial).dispose();
  }
}

const PALETTES: Record<string, readonly string[]> = {
  vivid: ['#ff5d5d', '#ff9f43', '#ffd93d', '#5be3a1', '#3ddcff', '#5c9dff', '#a66bff', '#ff6bd6'],
  pastel: ['#ffb3ba', '#ffdfba', '#ffffba', '#baffc9', '#bae1ff', '#d4baff', '#f5d0e6', '#e0e0e0'],
  earth: ['#6b4f3a', '#a67c52', '#c9a66b', '#7a8450', '#4f6b4f', '#8c5e58', '#d9c7a3', '#3d3d3d'],
  mono: ['#ffffff', '#d9d9d9', '#b3b3b3', '#8c8c8c', '#666666', '#404040', '#1f1f1f', '#000000'],
};
export const PAINT_PALETTES = PALETTES;

export class EdTools {
  constructor(private app: App) {}

  private pointOf(e: PointerEvent): Vector3 | null {
    const hit = this.app.pickEntity(e, { joints: false });
    return hit?.point ?? this.app.picker.groundPoint(e, 0);
  }

  // ---- blast variants (ED-40) ------------------------------------------------------------------

  blastDown(e: PointerEvent, input: InputController): void {
    const app = this.app;
    const at = this.pointOf(e);
    if (!at) return;
    const dir = app.picker.rayDirection(e);
    if (app.prefs.value.blastKind !== 'gust') {
      app.blast(at, dir);
      return;
    }
    if (!app.sim.active) {
      app.toast('Start the simulation to blow a gust', 'warn');
      return;
    }
    // A gust is a constant push for as long as the button is held: small impulses at 20 Hz along the view ray.
    let point = at;
    let gdir = dir;
    const dt = GUST_TICK_MS / 1000;
    app.effects.ping(at, 0xffb347);
    const timer = setInterval(() => app.blast(point, gdir, dt, true), GUST_TICK_MS);
    const stop = () => clearInterval(timer);
    input.beginCustom({
      move: (ev) => {
        point = this.pointOf(ev) ?? point;
        gdir = app.picker.rayDirection(ev);
      },
      up: stop,
      cancel: stop,
    });
  }

  // ---- throw / aim (ED-44) ---------------------------------------------------------------------

  throwDown(e: PointerEvent, input: InputController): void {
    const app = this.app;
    const t0 = performance.now();
    let last = e;
    let power = 1;
    const preview = new AimPreview(app);
    const redraw = () => {
      power = chargePower(performance.now() - t0);
      const cam = app.camera.position;
      const dir = app.picker.rayDirection(last);
      const info = preview.update(cam, dir, power);
      app.labels.set(
        'aim',
        cam.clone().addScaledVector(dir, 4),
        `${info.speed.toFixed(1)} m/s${info.range !== null ? ` · lands ${info.range.toFixed(1)} m away in ${info.time.toFixed(1)} s` : ''}`,
        'accent',
      );
    };
    redraw();
    const timer = setInterval(redraw, 33);
    const end = () => {
      clearInterval(timer);
      preview.dispose();
      app.labels.remove('aim');
    };
    input.beginCustom({
      move: (ev) => {
        last = ev;
      },
      up: (ev) => {
        end();
        const dir = app.picker.rayDirection(ev);
        app.shoot(app.camera.position.clone(), dir, chargePower(performance.now() - t0));
      },
      cancel: end,
    });
  }

  // ---- paint (ED-42) -----------------------------------------------------------------------------

  paintDown(e: PointerEvent, input: InputController): void {
    const app = this.app;
    const store = app.store;
    if (e.shiftKey) {
      // Eyedropper: take the colour (and, in material mode, the preset) of the body under the pointer.
      const hit = app.pickEntity(e, { joints: false });
      const ent = hit ? store.get(hit.entityId) : undefined;
      if (ent && isBody(ent)) {
        app.prefs.set({
          paintColor: ent.material.color,
          ...(ent.material.preset ? { paintMaterial: ent.material.preset } : {}),
        });
        app.toast(`Picked ${ent.material.color}`, 'info');
      } else if (ent && isSoft(ent)) {
        app.prefs.set({ paintColor: ent.color });
        app.toast(`Picked ${ent.color}`, 'info');
      }
      return;
    }
    let painted = 0;
    store.begin('Paint');
    const apply = (ev: PointerEvent) => {
      const hit = app.pickEntity(ev, { joints: false });
      if (hit && this.paintOne(hit.entityId)) painted++;
    };
    apply(e);
    input.beginCustom({
      move: apply,
      up: () => {
        store.end();
        if (!painted) app.toast('Click or drag over a body to paint it · Shift+click picks a colour', 'info');
      },
      cancel: () => store.end(),
    });
  }

  /** Paint one entity with the tool's colour / material; returns whether it was a paintable body. */
  private paintOne(id: string): boolean {
    const { store, prefs } = this.app;
    const p = prefs.value;
    const ent = store.get(id);
    if (!ent || ('locked' in ent && ent.locked)) return false;
    if (isBody(ent)) {
      if (p.paintMode === 'material') {
        const m = materialFromPreset(p.paintMaterial);
        if (ent.material.preset === m.preset) return true;
        store.update(id, { material: m }, 'Paint material');
      } else if (ent.material.color !== p.paintColor) {
        store.update(id, { material: { ...ent.material, color: p.paintColor } }, 'Paint');
      }
      return true;
    }
    if (isSoft(ent)) {
      if (ent.color !== p.paintColor) store.update(id, { color: p.paintColor }, 'Paint');
      return true;
    }
    return false;
  }

  // ---- pin (ED-43) -----------------------------------------------------------------------------

  pinDown(e: PointerEvent): void {
    const app = this.app;
    const hit = app.pickEntity(e, { joints: false });
    if (!hit) return;
    const store = app.store;
    const body = store.body(hit.entityId);
    if (!body) {
      app.toast('Pin works on bodies — soft bodies are pinned from their inspector (Pin setting)', 'warn');
      return;
    }
    if (e.shiftKey) {
      this.unpin(body.id, hit.point);
      return;
    }
    if (body.bodyType === 'static') {
      app.toast('A static body is already fixed in the world', 'warn');
      return;
    }
    const type = app.prefs.value.pinJoint;
    const p = hit.point;
    const j = app.editor.addJoint(
      type,
      { body: body.id, point: [p.x, p.y, p.z] },
      { body: null, point: [p.x, p.y, p.z] },
      undefined,
      { name: store.uniqueName('Pin') },
    );
    if (j) {
      app.effects.ping(p, 0x5be3a1);
      app.toast(`Pinned ${body.name} (${type}) — Shift+click it to unpin`, 'success');
    }
  }

  /** Remove the pin of `bodyId` nearest to `point`. */
  private unpin(bodyId: string, point: Vector3): void {
    const app = this.app;
    const pose = app.sim.poseOf(bodyId);
    let best: { id: string; d: number } | null = null;
    for (const j of app.store.jointsOf(bodyId)) {
      if (j.bodyB !== null || j.bodyA !== bodyId || !j.name.startsWith('Pin')) continue;
      const d = pose ? vlen(vsub(j.anchorB, [point.x, point.y, point.z])) : 0;
      if (!best || d < best.d) best = { id: j.id, d };
    }
    if (!best) {
      app.toast('Nothing pinned here', 'info');
      return;
    }
    app.store.remove([best.id], 'Unpin');
    app.toast('Unpinned', 'success');
  }
}

const cache = new WeakMap<App, EdTools>();
export const edTools = (app: App): EdTools => {
  let t = cache.get(app);
  if (!t) cache.set(app, (t = new EdTools(app)));
  return t;
};
