/** The per-frame update: advance the simulation, push poses into the views, overlays, labels and camera. */
import type { App } from './app';

export class FrameLoop {
  /** Smoothed frames-per-second estimate (updated twice a second). */
  fps = 60;
  /** Body colours are recomputed on the next frame (selection, mode or document changed). */
  private colorsDirty = true;
  private fpsAcc = 0;
  private fpsFrames = 0;

  constructor(private app: App) {}

  invalidateColors(): void {
    this.colorsDirty = true;
  }

  tick(dt: number): void {
    const { app } = this;
    // fps estimate
    this.fpsAcc += dt;
    this.fpsFrames++;
    if (this.fpsAcc >= 0.5) {
      this.fps = this.fpsFrames / this.fpsAcc;
      this.fpsAcc = 0;
      this.fpsFrames = 0;
    }

    app.sim.tick();
    const client = app.sim.client;
    const live = client.active && client.frameNo > 0;

    if (live) {
      app.viewSync.syncLayout(client);
      const poses = client.poses;
      for (const [id, view] of app.bodies.views) {
        const i = client.bodyIndex.get(id);
        if (i !== undefined) app.bodies.setPoseFromFrame(id, poses, i);
        else view.state = 0;
      }
      app.gizmos.keepInSync();
    }

    app.softs.applyFrame(client);
    app.viewSync.syncSoftLayout(client);
    for (const id of app.softs.views.keys()) app.softs.tint(id, app.store.selection.includes(id));

    app.bodies.hoverId = app.hoverId;
    if (live || this.colorsDirty || app.bodies.mode !== 'material') {
      const sel = new Set(app.store.selection);
      app.bodies.applyColors(live ? client.poses : null, (id) => client.bodyIndex.get(id), sel);
      this.colorsDirty = false;
    }

    const broken = client.broken;
    app.joints.updateFrame(app.camera, live ? client.joints : null, (id) => client.jointIndex.get(id), broken);

    const grav = Math.hypot(...app.store.settings.gravity);
    // Overlays also record the motion trails.
    app.overlays.update(
      app.camera,
      app.bodies,
      live ? client.poses : null,
      (id) => client.bodyIndex.get(id),
      client.contacts,
      client.frameNo,
      new Set(app.store.selection),
      client.info.mass,
      client.info.com,
      grav,
    );

    app.effects.update(dt);
    app.componentFx.update(dt); // -- CP
    app.cameraControl.updateFollow(dt);
    app.measureTool.updateLabel();
    const rect = app.viewport.dom.getBoundingClientRect();
    app.viewSync.frameAux(rect.width, rect.height);
    app.labels.update(app.camera, rect.width, rect.height);

    app.emit('frame', { dt });
  }
}
