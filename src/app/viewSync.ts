/**
 * Document → views: keeps the body / soft / joint views, the selection outline and the ephemeral
 * (simulation-only) views in step with the scene store and the live simulation's layout.
 */
import type { Object3D } from 'three';
import { isBody, isJoint, isSoft } from '../model/types';
import type { SceneChange } from '../model/store';
import type { SimClient } from '../physics/client';
import type { App } from './app';

export class ViewSync {
  private lastLayout = -1;
  private lastSoftLayout = -1;

  constructor(private app: App) {}

  rebuildAll(): void {
    const { app } = this;
    app.bodies.clear();
    app.joints.clear();
    app.softs.clear();
    for (const e of app.store.all()) {
      if (isBody(e)) app.bodies.add(e);
      else if (isSoft(e)) app.softs.add(e);
    }
    for (const e of app.store.all()) if (isJoint(e)) app.joints.add(e);
    app.viewport.setGround(app.store.settings.ground);
    this.onSelectionChanged();
    app.emit('scene', undefined);
  }

  onStoreChange(c: SceneChange): void {
    const { app } = this;
    switch (c.type) {
      case 'reset':
        this.rebuildAll();
        break;
      case 'add':
        for (const id of c.ids) {
          const e = app.store.get(id);
          if (isBody(e)) app.bodies.add(e);
          else if (isSoft(e)) app.softs.add(e);
        }
        for (const id of c.ids) {
          const e = app.store.get(id);
          if (isJoint(e)) app.joints.add(e);
        }
        break;
      case 'remove':
        for (const e of c.removed) {
          if (isBody(e)) app.bodies.remove(e.id);
          else if (isSoft(e)) app.softs.remove(e.id);
          else app.joints.remove(e.id);
        }
        break;
      case 'update':
        for (const id of c.ids) {
          const e = app.store.get(id);
          if (isBody(e)) {
            // A rebuilt view (parts changed) has a new root object: the selection outline must follow it.
            if (app.bodies.update(e)) this.refreshOutline();
            const view = app.bodies.get(id);
            // Document poses only drive the view when no live world owns the body.
            if (view && !(app.sim.client.active && app.sim.client.bodyIndex.has(id))) view.setPoseFromDef(e);
          } else if (isJoint(e)) app.joints.update(e);
          else if (isSoft(e) && !app.sim.client.softIndex.has(id)) app.softs.update(e);
          else if (isSoft(e)) app.softs.get(id)?.apply(e);
        }
        break;
      case 'settings':
        if (c.keys.has('ground')) app.viewport.setGround(app.store.settings.ground);
        break;
      case 'assets':
        break; // nothing is drawn from assets yet
    }
    app.invalidateColors();
    app.gizmos.refresh();
  }

  /** Create / remove views for simulation-only bodies and reset states after a layout change. */
  reconcile(): void {
    const { app } = this;
    // Remove ephemeral views no longer present.
    for (const [id] of [...app.bodies.views]) {
      if (!app.store.has(id) && !app.sim.ephemeral.has(id)) app.bodies.remove(id);
    }
    for (const [id, def] of app.sim.ephemeral) if (!app.bodies.get(id)) app.bodies.add(def);
    if (!app.sim.active) {
      app.softs.endSim();
      this.lastSoftLayout = -1;
      app.bodies.resetStates();
      for (const e of app.store.bodies()) {
        const v = app.bodies.get(e.id);
        if (v) v.setPoseFromDef(e);
      }
      app.overlays.hideAll();
      app.overlays.clearTrails();
    }
    app.gizmos.refresh();
  }

  onSelectionChanged(): void {
    const { app } = this;
    const ids = new Set(app.store.selection);
    this.refreshOutline();
    app.joints.setSelected(ids);
    app.gizmos.jointEnd = 'A';
    app.gizmos.refresh();
    app.invalidateColors();
  }

  refreshOutline(): void {
    const { app } = this;
    const meshes: Object3D[] = [];
    for (const id of app.store.selection) {
      const v = app.bodies.get(id);
      if (v) meshes.push(v.mesh);
      const sm = app.softs.meshOf(id);
      if (sm) meshes.push(sm);
    }
    app.viewport.setOutlineTargets(meshes);
  }

  /** Per frame: the simulation announced a new set of bodies / joints → reconcile the views. */
  syncLayout(client: SimClient): void {
    if (client.layoutNo !== this.lastLayout) {
      this.lastLayout = client.layoutNo;
      this.reconcile();
    }
  }

  /** Per frame: soft-body topology changed (spawn, tear) → the outline meshes changed too. */
  syncSoftLayout(client: SimClient): void {
    if (client.softLayoutNo !== this.lastSoftLayout) {
      this.lastSoftLayout = client.softLayoutNo;
      this.refreshOutline();
    }
  }
}
