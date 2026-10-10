/**
 * Zone views (ZN-1): zones are ordinary bodies, so the body views already draw them; this adds what makes a zone
 * look like a *volume* and the world bounds like a playfield.
 *
 *  - **Volumes.** A body with a `zone` component is drawn as a translucent, unlit-looking tinted volume with a crisp
 *    outline, in the colour of its action (or its own colour), brighter when selected or hovered, dim when its
 *    component is switched off. It casts no shadow and is *picked last*: a ray that also hits a solid body picks the
 *    solid body, so objects inside a zone stay clickable (a click on a zone volume with nothing behind it selects the
 *    zone). While the simulation runs the volume is hidden unless the zone says "show while running".
 *  - **Captions.** In the editor every zone nearby carries a small label — its own, or its action ("Checkpoint 2").
 *  - **World bounds.** When the bounds are enabled their box is drawn: every face tinted by what it does (red = kill,
 *    amber = soft wall, blue = water), an inner outline where a soft wall starts, and plain outlines for open faces.
 *
 * Everything is derived from the document each time it changes; per frame only the cheap appearance is re-asserted
 * (the body views recolour their materials every frame while the simulation runs).
 */
import {
  BoxGeometry,
  Color,
  DoubleSide,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Vector3,
} from 'three';
import type { App } from '../app/app';
import { halfHeight } from '../model/shapes';
import type { BoundsEdge, BoundsSettings } from '../model/types';
import { zoneActionInfo } from '../model/zones';
import type { BodyView } from './bodyViews';

/** Added to the distance of a ray hit on a zone volume, so any solid hit is nearer. */
const PICK_PENALTY = 1e4;
/** Labels are shown for zones this close to the camera (metres). */
const LABEL_RANGE = 70;

interface ZoneLook {
  action: string;
  color: string;
  caption: string;
  showInRun: boolean;
  enabled: boolean;
}

interface Edge {
  piece: Mesh;
  line: LineSegments;
  geometryId: string;
}

interface Deco {
  view: BodyView;
  edges: Edge[];
  /** Appearance written last time, to skip needless material updates. */
  sig: string;
}

const patched = new WeakSet<Mesh>();

/** Make a zone volume lose every pick against solid meshes (see the module comment). */
function deprioritisePicking(mesh: Mesh): void {
  if (patched.has(mesh)) return;
  patched.add(mesh);
  mesh.raycast = function (this: Mesh, raycaster, intersects) {
    const before = intersects.length;
    Mesh.prototype.raycast.call(this, raycaster, intersects);
    for (let i = before; i < intersects.length; i++) intersects[i].distance += PICK_PENALTY;
  };
}

/** What a zone is called on screen. */
export function zoneCaption(look: {
  action: string;
  label: string;
  race?: string;
  index?: number;
  laps?: number;
}): string {
  if (look.label) return look.label;
  const info = zoneActionInfo(look.action);
  if (look.action === 'checkpoint') return `Checkpoint ${look.index ?? 1}`;
  if (look.action === 'finish' && (look.laps ?? 1) > 1) return `${info.label} · ${look.laps} laps`;
  return info.label;
}

export class ZoneViews {
  private decos = new Map<string, Deco>();
  private looks = new Map<string, ZoneLook>();
  private dirty = true;
  private labelKeys = new Set<string>();
  private readonly tint = new Color();
  private readonly bounds: BoundsView;

  constructor(private readonly app: App) {
    this.bounds = new BoundsView(app.viewport.helpers);
    app.store.on('change', (c) => {
      this.dirty = true;
      if (c.type === 'reset' || (c.type === 'settings' && c.keys.has('bounds')))
        this.bounds.set(app.store.settings.bounds);
    });
    app.sim.on('mode', () => {
      this.dirty = true;
    });
    this.bounds.set(app.store.settings.bounds);
    app.on('frame', () => this.update());
  }

  /** The look of the zone on a body (first zone component), or undefined. */
  look(id: string): ZoneLook | undefined {
    return this.looks.get(id);
  }

  private scan(): void {
    this.looks.clear();
    for (const e of this.app.store.all()) {
      if (e.kind !== 'body') continue;
      const c = e.components.find((x) => x.type === 'zone');
      if (!c) continue;
      const action = typeof c.params.action === 'string' ? c.params.action : 'none';
      const custom = c.params.customColor === true && typeof c.params.color === 'string';
      this.looks.set(e.id, {
        action,
        color: custom ? (c.params.color as string) : zoneActionInfo(action).color,
        caption: zoneCaption({
          action,
          label: typeof c.params.label === 'string' ? c.params.label : '',
          index: typeof c.params.index === 'number' ? c.params.index : 1,
          laps: typeof c.params.laps === 'number' ? c.params.laps : 1,
        }),
        showInRun: c.params.showInRun === true,
        enabled: e.components.some((x) => x.type === 'zone' && x.enabled),
      });
    }
    // volumes of bodies that are no longer zones
    for (const [id, d] of this.decos) {
      if (!this.looks.has(id) || this.app.bodies.get(id) !== d.view) this.drop(id);
    }
    this.dirty = false;
  }

  private drop(id: string): void {
    const d = this.decos.get(id);
    if (!d) return;
    for (const e of d.edges) {
      e.piece.remove(e.line);
      e.line.geometry.dispose();
      (e.line.material as LineBasicMaterial).dispose();
    }
    this.decos.delete(id);
  }

  private update(): void {
    const { app } = this;
    if (this.dirty) this.scan();
    const running = app.sim.active;
    const selected = new Set(app.store.selection);
    const wanted = new Set<string>();
    for (const [id, look] of this.looks) {
      const view = app.bodies.get(id);
      if (!view) continue;
      let deco = this.decos.get(id);
      if (!deco || deco.view !== view) {
        this.drop(id);
        deco = { view, edges: [], sig: '' };
        this.decos.set(id, deco);
      }
      // outlines follow the shapes drawn (a resized or re-shaped zone gets new geometry)
      for (const piece of view.pieces) {
        deprioritisePicking(piece.mesh);
        const existing = deco.edges.find((e) => e.piece === piece.mesh);
        if (existing && existing.geometryId === piece.mesh.geometry.uuid) continue;
        if (existing) {
          existing.piece.remove(existing.line);
          existing.line.geometry.dispose();
          deco.edges.splice(deco.edges.indexOf(existing), 1);
        }
        const line = new LineSegments(
          new EdgesGeometry(piece.mesh.geometry, 28),
          new LineBasicMaterial({ transparent: true, opacity: 0.95, depthWrite: false }),
        );
        line.renderOrder = 4;
        line.raycast = () => undefined;
        piece.mesh.add(line);
        deco.edges.push({ piece: piece.mesh, line, geometryId: piece.mesh.geometry.uuid });
      }
      const hot = selected.has(id);
      const hover = app.hoverId === id;
      const level = !look.enabled ? 0.06 : hot ? 0.34 : hover ? 0.26 : 0.18;
      this.tint.set(look.color);
      for (const piece of view.pieces) {
        const m = piece.material;
        m.color.copy(this.tint);
        m.emissive.copy(this.tint).multiplyScalar(look.enabled ? 0.35 : 0.05);
        m.opacity = level;
        if (!m.transparent || m.depthWrite) {
          m.transparent = true;
          m.depthWrite = false;
          m.needsUpdate = true;
        }
        m.roughness = 1;
        m.metalness = 0;
        piece.mesh.castShadow = false;
        piece.mesh.receiveShadow = false;
        piece.mesh.renderOrder = 3;
      }
      const lineOpacity = !look.enabled ? 0.3 : hot ? 1 : 0.85;
      for (const e of deco.edges) {
        const lm = e.line.material as LineBasicMaterial;
        lm.color.copy(this.tint).lerp(WHITE, hot ? 0.55 : 0.2);
        lm.opacity = lineOpacity;
      }
      // visibility: in the editor as the body view decided; while running only if the zone asks
      if (running) view.mesh.visible = look.showInRun && !view.def.hidden && view.state !== 2;
      // captions
      const key = `zone:${id}`;
      if (!running && view.mesh.visible && view.position.distanceTo(app.camera.position) < LABEL_RANGE) {
        const top = view.position.clone().add(new Vector3(0, halfHeight(view.def.shape) + 0.25, 0));
        app.labels.set(key, top, look.caption, `zone-label${hot ? ' accent' : ''}${look.enabled ? '' : ' off'}`);
        wanted.add(key);
      }
    }
    for (const key of this.labelKeys) if (!wanted.has(key)) app.labels.remove(key);
    this.labelKeys = wanted;
    this.bounds.visible = app.store.settings.bounds.enabled;
  }

  /** Test hook: how many volumes are decorated right now. */
  get volumeCount(): number {
    return this.decos.size;
  }
}

const WHITE = new Color('#ffffff');

// ── world bounds ─────────────────────────────────────────────────────────────────────────────────────

const EDGE_COLORS: Record<BoundsEdge, string> = {
  open: '#8896ab',
  kill: '#ff5d73',
  soft: '#ffb347',
  water: '#38a8ff',
};

/** The faces of a box: key, axis, sign (+1 at `max`). */
const FACES = [
  { key: 'nx', axis: 0, sign: -1 },
  { key: 'px', axis: 0, sign: 1 },
  { key: 'ny', axis: 1, sign: -1 },
  { key: 'py', axis: 1, sign: 1 },
  { key: 'nz', axis: 2, sign: -1 },
  { key: 'pz', axis: 2, sign: 1 },
] as const;

class BoundsView {
  private readonly root = new Group();
  private readonly disposables: { dispose(): void }[] = [];

  constructor(parent: Group) {
    this.root.name = 'world-bounds';
    this.root.visible = false;
    parent.add(this.root);
  }

  set visible(v: boolean) {
    this.root.visible = v;
  }

  /** Rebuild the box for the given settings. */
  set(b: BoundsSettings): void {
    for (const o of this.disposables) o.dispose();
    this.disposables.length = 0;
    this.root.clear();
    const size = new Vector3(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
    const centre = new Vector3((b.max[0] + b.min[0]) / 2, (b.max[1] + b.min[1]) / 2, (b.max[2] + b.min[2]) / 2);
    this.root.visible = b.enabled;
    if (!b.enabled) return;

    const box = new BoxGeometry(size.x, size.y, size.z);
    const outlineGeo = new EdgesGeometry(box);
    const outlineMat = new LineBasicMaterial({ color: '#8896ab', transparent: true, opacity: 0.45, depthWrite: false });
    const outline = new LineSegments(outlineGeo, outlineMat);
    outline.position.copy(centre);
    outline.raycast = () => undefined;
    this.root.add(outline);
    this.disposables.push(box, outlineGeo, outlineMat);

    for (const f of FACES) {
      const edge = b.edges[f.key];
      if (edge === 'open') continue;
      const dims: [number, number] =
        f.axis === 0 ? [size.z, size.y] : f.axis === 1 ? [size.x, size.z] : [size.x, size.y];
      const geo = new PlaneGeometry(dims[0], dims[1]);
      const mat = new MeshBasicMaterial({
        color: EDGE_COLORS[edge],
        transparent: true,
        opacity: edge === 'water' ? 0.16 : 0.07,
        side: DoubleSide,
        depthWrite: false,
      });
      const plane = new Mesh(geo, mat);
      plane.renderOrder = 2;
      plane.raycast = () => undefined;
      const at = centre.clone();
      const axisVec = [0, 0, 0];
      axisVec[f.axis] = 1;
      at.setComponent(f.axis, f.sign > 0 ? b.max[f.axis] : b.min[f.axis]);
      plane.position.copy(at);
      // PlaneGeometry faces +z; turn it to face along the axis of the box face
      if (f.axis === 0) plane.rotation.y = Math.PI / 2;
      else if (f.axis === 1) plane.rotation.x = Math.PI / 2;
      this.root.add(plane);
      this.disposables.push(geo, mat);

      const ring = new LineSegments(
        new EdgesGeometry(geo),
        new LineBasicMaterial({ color: EDGE_COLORS[edge], transparent: true, opacity: 0.7, depthWrite: false }),
      );
      ring.position.copy(plane.position);
      ring.rotation.copy(plane.rotation);
      ring.raycast = () => undefined;
      this.root.add(ring);
      this.disposables.push(ring.geometry, ring.material);

      if (edge === 'soft') {
        // where the spring wall starts: the same outline, `margin` metres inside
        const inner = new LineSegments(
          new EdgesGeometry(geo),
          new LineBasicMaterial({ color: EDGE_COLORS.soft, transparent: true, opacity: 0.35, depthWrite: false }),
        );
        inner.position.copy(plane.position);
        inner.position.setComponent(
          f.axis,
          plane.position.getComponent(f.axis) - f.sign * Math.min(b.soft.margin, size.getComponent(f.axis) / 2),
        );
        inner.rotation.copy(plane.rotation);
        inner.raycast = () => undefined;
        this.root.add(inner);
        this.disposables.push(inner.geometry, inner.material);
      }
    }
  }
}
