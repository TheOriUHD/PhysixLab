/** Scene-level commands used by the UI: adding shapes / soft bodies / prefabs and loading scenes. */
import { Vector3 } from 'three';
import type { Quat, Vec3 } from '../core/math';
import { translateEntities } from '../model/builder';
import { createBody, newDocument } from '../model/factory';
import { halfHeight } from '../model/shapes';
import { cloneEntities } from '../model/store';
import { getMap, getPrefab, getTemplate } from '../model/content';
import type { BodyEntity, LightType, SceneDocument, ShapeType, SoftType } from '../model/types';
import type { App } from './app';
import { dropPoseForShape } from './edit/surfaceDrop';
import { placeEntities } from '../model/edit/shapeSupport';

export class SceneCommands {
  constructor(private app: App) {}

  addShape(type: ShapeType, at?: Vec3, rotation?: Quat): BodyEntity {
    const { app } = this;
    // -- ED-A snap: a click-to-add lands on the surface at the view centre (and may align to its normal) --
    let pose: { position: Vec3; rotation: Quat } | null = null;
    if (!at) {
      const rect = app.viewport.dom.getBoundingClientRect();
      pose = dropPoseForShape(
        app,
        { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height * 0.6 },
        type,
        createBody({ shape: { type } }).shape.size,
      );
    }
    const rot = rotation ?? pose?.rotation;
    const body = app.editor.addShape(type, at ?? pose?.position, rot && rot[3] < 0.9999999 ? { rotation: rot } : {});
    app.effects.ping(
      new Vector3(body.position[0], Math.max(0, body.position[1] - halfHeight(body.shape)), body.position[2]),
    );
    return body;
  }

  addSoft(type: SoftType): void {
    const { app } = this;
    const t = app.viewport.controls.target;
    const s = app.prefs.value.snap ? app.prefs.value.snapGrid : 0.01;
    const sf = app.editor.addSoft(type, undefined, {
      position: [
        Math.round(t.x / s) * s,
        type === 'jelly' ? 0.56 : type === 'balloon' ? 0.55 : 2.4,
        Math.round(t.z / s) * s,
      ],
    });
    app.effects.ping(new Vector3(sf.position[0], 0, sf.position[2]));
  }

  /** View-centre position on the ground plane (snapped like new shapes), at height `y`. */
  private viewSpot(y: number): Vec3 {
    const { app } = this;
    const t = app.viewport.controls.target;
    const s = app.prefs.value.snap ? app.prefs.value.snapGrid : 0.01;
    return [Math.round(t.x / s) * s, y, Math.round(t.z / s) * s];
  }

  addLight(type: LightType): void {
    const { app } = this;
    const at = this.viewSpot(type === 'directional' ? 6 : 3);
    const light = app.editor.addLight(type, at);
    app.effects.ping(new Vector3(light.position[0], 0, light.position[2]));
  }

  addPath(): void {
    const { app } = this;
    const at = this.viewSpot(0.05);
    const path = app.editor.addPath(at);
    app.effects.ping(new Vector3(path.position[0], 0, path.position[2]));
  }

  /** Group the selection, or — with nothing selected — add an empty group in front of the view. */
  addGroup(): void {
    const { app } = this;
    if (app.store.selection.length && app.editor.groupSelection()) return;
    app.editor.addGroup(this.viewSpot(0));
  }

  insertPrefab(id: string, drop?: { position: Vec3; rotation?: Quat }): void {
    const { app } = this;
    const pf = getPrefab(id);
    if (!pf) return;
    const t = app.viewport.controls.target;
    const snap = app.prefs.value.snap ? 0.5 : 0.01;
    // -- ED-A snap: a drop from the library lands at the pose found by the pointer ray; a click keeps the view target --
    const at: Vec3 = drop?.position ?? [Math.round(t.x / snap) * snap, 0, Math.round(t.z / snap) * snap];
    const list = drop ? placeEntities(pf.build(), at, drop.rotation ?? null) : translateEntities(pf.build(), at);
    // Re-id so repeated insertions never collide.
    const copies = cloneEntities(
      list,
      list.map((e) => e.id),
      [0, 0, 0],
    ).map((e) => ({ ...e, name: app.store.uniqueName(e.name) }));
    app.store.add(copies, `Insert ${pf.name}`);
    if (!drop) app.frameSelection(); // -- ED-A snap: a drop stays where the user put it --
    app.toast(`${pf.name} inserted`, 'success');
  }

  loadDocument(doc: SceneDocument, view?: 'frame'): void {
    const { app } = this;
    app.sim.reset();
    app.store.load(doc);
    app.persistence.saveNow();
    if (view === 'frame') app.frameAll(false);
  }

  loadTemplate(id: string): void {
    const { app } = this;
    const t = getTemplate(id);
    if (!t) return;
    this.loadDocument(t.build(), t.view ? undefined : 'frame');
    if (t.view) app.viewport.flyTo(new Vector3(...t.view.position), new Vector3(...t.view.target), 0.6);
    if (t.follow) {
      const b = app.store.bodies().find((x) => x.name === t.follow);
      if (b) app.store.setSelection([b.id]);
      app.prefs.set({ followSelection: true });
    } else app.prefs.set({ followSelection: false });
    app.toast(t.hint, 'info');
  }

  /** Open a registered map: its scene, its opening camera, and its objective as the hint. */
  loadMap(id: string): void {
    const { app } = this;
    const m = getMap(id);
    if (!m) return;
    this.loadDocument(m.build());
    app.viewport.flyTo(new Vector3(...m.camera.position), new Vector3(...m.camera.target), 0.6);
    app.prefs.set({ followSelection: false });
    app.toast(m.objective, 'info');
  }

  newScene(): void {
    this.loadDocument(newDocument('Untitled scene'));
    this.app.viewport.setView({ position: [9, 7, 11], target: [0, 1.2, 0] });
  }
}
