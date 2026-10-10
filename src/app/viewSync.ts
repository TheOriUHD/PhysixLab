/**
 * Document → views: keeps the body / soft / joint views, the selection outline and the ephemeral
 * (simulation-only) views in step with the scene store and the live simulation's layout.
 */
import type { Object3D, Box3 } from 'three';
import { Vector3 } from 'three';
import { childIndex, descendantIds } from '../model/groups';
import { isBody, isGroup, isJoint, isLight, isPath, isSoft } from '../model/types';
import type { SceneChange } from '../model/store';
import type { Entity } from '../model/types';
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
    app.groupViews.clear();
    app.lightViews.clear();
    app.pathViews.clear();
    for (const e of app.store.all()) {
      if (isBody(e)) app.bodies.add(e);
      else if (isSoft(e)) app.softs.add(e);
      else this.addAux(e);
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
          else if (e) this.addAux(e);
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
          else if (isJoint(e)) app.joints.remove(e.id);
          else this.removeAux(e.id);
        }
        this.checkPathPoint();
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
          else if (e) this.updateAux(e);
        }
        break;
      case 'settings':
        if (c.keys.has('ground')) app.viewport.setGround(app.store.settings.ground);
        break;
      case 'assets':
        break; // nothing is drawn from assets yet
    }
    app.groupViews.markDirty();
    app.invalidateColors();
    app.gizmos.refresh();
  }

  // ---- groups, lights, paths (FB-6) -----------------------------------------------------------

  private addAux(e: Entity): void {
    const { app } = this;
    if (isGroup(e)) app.groupViews.add(e);
    else if (isLight(e)) app.lightViews.add(e);
    else if (isPath(e)) app.pathViews.add(e);
  }

  private updateAux(e: Entity): void {
    const { app } = this;
    if (isGroup(e)) app.groupViews.update(e);
    else if (isLight(e)) app.lightViews.update(e);
    else if (isPath(e)) {
      app.pathViews.update(e);
      this.checkPathPoint();
    }
  }

  private removeAux(id: string): void {
    const { app } = this;
    app.groupViews.remove(id);
    app.lightViews.remove(id);
    app.pathViews.remove(id);
  }

  /** The edited path point must still exist (it may have been deleted, or undone away). */
  private checkPathPoint(): void {
    const { app } = this;
    const pp = app.pathPoint;
    if (!pp) return;
    const path = app.store.path(pp.id);
    if (!path || pp.index >= path.points.length) app.setPathPoint(null);
  }

  /** Per frame: group boxes (rebuilt lazily), helper visibility while simulating, the path line resolution. */
  frameAux(width: number, height: number): void {
    const { app } = this;
    app.pathViews.setResolution(width, height);
    // The hierarchy index is built only when the group boxes are actually rebuilt (after a document change).
    let index: Map<string, string[]> | null = null;
    app.groupViews.tick(
      app.sim.active,
      (id) => descendantIds((index ??= childIndex(app.store.all())), id),
      (id, box) => this.expandBounds(id, box),
    );
  }

  /** Grow `box` by what the entity occupies in the viewport. */
  private expandBounds(id: string, box: Box3): void {
    const { app } = this;
    const body = app.bodies.get(id);
    if (body) return void box.expandByObject(body.mesh);
    const soft = app.softs.meshOf(id);
    if (soft) return void box.expandByObject(soft);
    const light = app.store.light(id);
    if (light) return void box.expandByPoint(new Vector3(...light.position));
    const path = app.pathViews.get(id);
    if (path) return void box.expandByObject(path.root);
    const group = app.store.group(id);
    if (group) box.expandByPoint(new Vector3(...group.position));
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
    app.groupViews.setSelected(ids);
    app.lightViews.setSelected(ids);
    app.pathViews.setSelected(ids);
    // The edited path point only makes sense while its path is the one selected object.
    const pp = app.pathPoint;
    if (pp && !(ids.size === 1 && ids.has(pp.id))) app.setPathPoint(null);
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
