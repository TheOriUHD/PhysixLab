/** Scene-level commands used by the UI: adding shapes / soft bodies / prefabs and loading scenes. */
import { Vector3 } from 'three';
import type { Vec3 } from '../core/math';
import { translateEntities } from '../model/builder';
import { createBody, newDocument } from '../model/factory';
import { PREFABS } from '../model/prefabs';
import { halfHeight } from '../model/shapes';
import { cloneEntities } from '../model/store';
import { TEMPLATE_BY_ID } from '../model/templates';
import type { BodyEntity, SceneDocument, ShapeType, SoftType } from '../model/types';
import type { App } from './app';

export class SceneCommands {
  constructor(private app: App) {}

  addShape(type: ShapeType, at?: Vec3): BodyEntity {
    const { app } = this;
    const body = app.editor.addShape(
      type,
      at ?? app.viewCenterPlacement(type, createBody({ shape: { type } }).shape.size),
    );
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

  insertPrefab(id: string): void {
    const { app } = this;
    const pf = PREFABS.find((p) => p.id === id);
    if (!pf) return;
    const t = app.viewport.controls.target;
    const snap = app.prefs.value.snap ? 0.5 : 0.01;
    const at: Vec3 = [Math.round(t.x / snap) * snap, 0, Math.round(t.z / snap) * snap];
    const list = translateEntities(pf.build(), at);
    // Re-id so repeated insertions never collide.
    const copies = cloneEntities(
      list,
      list.map((e) => e.id),
      [0, 0, 0],
    ).map((e) => ({ ...e, name: app.store.uniqueName(e.name) }));
    app.store.add(copies, `Insert ${pf.name}`);
    app.frameSelection();
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
    const t = TEMPLATE_BY_ID.get(id);
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

  newScene(): void {
    this.loadDocument(newDocument('Untitled scene'));
    this.app.viewport.setView({ position: [9, 7, 11], target: [0, 1.2, 0] });
  }
}
