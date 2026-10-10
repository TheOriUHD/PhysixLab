/** Camera commands: frame the selection / the whole scene, and follow the selected body. */
import { Box3, Vector3 } from 'three';
import type { App } from './app';

export class CameraControl {
  private followOffset: Vector3 | null = null;

  constructor(private app: App) {}

  frameSelection(): void {
    const { app } = this;
    const ids = app.store.selection;
    if (!ids.length) {
      this.frameAll();
      return;
    }
    const box = new Box3();
    let any = false;
    for (const id of ids) {
      const v = app.bodies.get(id);
      if (v) {
        box.expandByObject(v.mesh);
        any = true;
        continue;
      }
      const sm = app.softs.meshOf(id);
      if (sm) {
        box.expandByObject(sm);
        any = true;
        continue;
      }
      const aux = app.store.group(id) ?? app.store.light(id) ?? app.store.path(id);
      if (aux) {
        const path = app.pathViews.get(id);
        const gbox = app.groupViews.get(id)?.box;
        if (path) box.expandByObject(path.root);
        else if (gbox && !gbox.isEmpty()) box.union(gbox);
        else box.expandByPoint(new Vector3(...aux.position));
        any = true;
        continue;
      }
      const j = app.store.joint(id);
      if (j) {
        const f = app.joints.frameOf(j, { a: new Vector3(), b: new Vector3(), axis: new Vector3() });
        if (f) {
          box.expandByPoint(f.a);
          box.expandByPoint(f.b);
          any = true;
        }
      }
    }
    if (!any) return;
    const c = box.getCenter(new Vector3());
    app.viewport.frame(c, Math.max(0.6, box.getSize(new Vector3()).length() / 2), true);
  }

  frameAll(keepDirection = true): void {
    const { app } = this;
    const box = new Box3();
    let any = false;
    for (const v of app.bodies.views.values()) {
      if (v.def.hidden) continue;
      box.expandByObject(v.mesh);
      any = true;
    }
    for (const sv of app.softs.views.values()) {
      if (sv.def.hidden) continue;
      box.expandByObject(sv.active);
      any = true;
    }
    for (const v of app.pathViews.views.values()) {
      if (v.def.hidden) continue;
      box.expandByObject(v.root);
      any = true;
    }
    for (const v of app.lightViews.views.values()) {
      if (v.def.hidden) continue;
      box.expandByPoint(new Vector3(...v.def.position));
      any = true;
    }
    if (!any) {
      app.viewport.flyTo(new Vector3(9, 7, 11), new Vector3(0, 1.2, 0));
      return;
    }
    const c = box.getCenter(new Vector3());
    const r = Math.min(40, Math.max(2.5, box.getSize(new Vector3()).length() / 2));
    app.viewport.frame(c, r, keepDirection);
  }

  /** Per frame: glide the orbit target (and the camera with it) after the selected body. */
  updateFollow(dt: number): void {
    const { app } = this;
    if (!app.prefs.value.followSelection) {
      this.followOffset = null;
      return;
    }
    const id = app.store.selection.find((s) => app.bodies.get(s));
    const v = id ? app.bodies.get(id) : null;
    if (!v) return;
    const c = app.viewport.controls;
    if (!this.followOffset) this.followOffset = c.target.clone().sub(v.position);
    const desired = v.position.clone();
    const delta = desired
      .clone()
      .sub(c.target)
      .multiplyScalar(1 - Math.exp(-9 * dt));
    c.target.add(delta);
    app.camera.position.add(delta);
  }
}
