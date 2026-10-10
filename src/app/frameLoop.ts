/** The per-frame update: advance the simulation, push poses into the views, overlays, labels and camera. */
import type { App } from './app';
import { PHYSICS, SCENE, UI, profiler } from '../core/profiler'; // -- UI-B: frame timing --

export class FrameLoop {
  /** Smoothed frames-per-second estimate (updated twice a second). */
  fps = 60;
  /** Body colours are recomputed on the next frame (selection, mode or document changed). */
  private colorsDirty = true;
  private fpsAcc = 0;
  private fpsFrames = 0;
  private reflectTick = 0;
  private readonly skinKeys = new Set<string>();

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

    app.input.update(dt); // -- CM-A --
    app.sim.tick();
    profiler.mark(PHYSICS); // -- UI-B: frame timing --
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

    if (app.bodies.hoverId !== app.hoverId) {
      // -- VZ-B: the hover outline (and instance promotion) follows the pointer --
      this.colorsDirty = true;
      app.bodies.hoverId = app.hoverId;
      app.viewSync.refreshOutline();
    }
    app.bodies.hoverId = app.hoverId;
    if (live || this.colorsDirty || app.bodies.mode !== 'material') {
      const sel = new Set(app.store.selection);
      app.bodies.applyColors(live ? client.poses : null, (id) => client.bodyIndex.get(id), sel);
      this.colorsDirty = false;
    }

    // The brake / reverse input also arrives as the analog `drive` axis (keyboard ramp, pad trigger): a skin that
    // listens for KeyS (the car's brake lights) must see it as that key.
    const skinKeys = this.skinKeys;
    for (const k of app.sim.keys) skinKeys.add(k);
    if (app.input.axisValue('drive') < -0.1) skinKeys.add('KeyS');
    app.bodies.updateSkins(dt, skinKeys, app.sim.active);
    this.skinKeys.clear();
    // SSR reflects only glossy / metallic bodies; the list is rebuilt twice a second while the effect is on.
    if (app.viewport.resolvedGraphics.ssr && ++this.reflectTick % 30 === 1)
      app.viewport.post.reflectives = app.bodies.reflectiveMeshes();
    if (!app.camera.ortho)
      app.bodies.updateLod(app.camera.position, app.viewport.dom.clientHeight, (app.camera.fov * Math.PI) / 180);
    app.bodies.flush();
    app.viewport.refreshDecor(); // -- VZ-B: instance buffers (VZ-30) --

    // -- JT-B: joint load estimates run while the stress overlay is on or a joint inspector is showing them --
    client.watchLoads(app.prefs.value.overlays.stress || performance.now() - app.loadWatchStamp < 800);
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
    app.cameraRig.update(dt); // -- CM-A --
    app.fxDirector.update(dt); // ── FX: particles, trails, skid marks ──
    app.audioDirector.update(dt); // ── FX: impact, rolling, engine and wind sound ──
    app.measureTool.updateLabel();
    const rect = app.viewport.dom.getBoundingClientRect();
    app.viewSync.frameAux(rect.width, rect.height);
    app.labels.update(app.camera, rect.width, rect.height);

    profiler.mark(SCENE); // -- UI-B: frame timing --
    app.emit('frame', { dt });
    profiler.mark(UI); // -- UI-B: frame timing --
  }
}
