/**
 * Plays a cinematic shot through the camera rig: preview, scrub, loop, and record. A *session* starts when a shot is
 * opened (the camera is taken over, the view it had is remembered) and ends with `close()`, which glides back to
 * that view. Recording goes through the recorder registry: the built-in one writes a WebM of the canvas, and the
 * export package can register a better one without touching this file.
 */
import { Emitter } from '../../core/events';
import { Registry } from '../../core/registry';
import { pathCurveOf, type PathCurve } from '../../model/path';
import type { CameraShot } from '../../model/types';
import type { App } from '../app';
import { newPose, type Pose } from './poses';
import { shotPose, type ShotEnv } from './shots';
import type { CameraRig } from './rig';

export interface ShotRecorder {
  id: string;
  label: string;
  available(): boolean;
  /** Start capturing the viewport; the returned function stops and delivers the file. */
  start(app: App, shot: CameraShot): Promise<() => Promise<void>>;
}

export const shotRecorders = new Registry<ShotRecorder>({ kind: 'shot recorder' });
export const registerShotRecorder = (r: ShotRecorder): (() => void) => shotRecorders.register(r);

/** The built-in recorder: the viewport canvas as a WebM file, through MediaRecorder. */
export const webmRecorder: ShotRecorder = {
  id: 'webm',
  label: 'WebM video',
  available: () =>
    typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function',
  start(app, shot) {
    const canvas = app.viewport.dom;
    const stream = canvas.captureStream(60);
    const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) =>
      MediaRecorder.isTypeSupported(t),
    );
    const rec = new MediaRecorder(stream, type ? { mimeType: type, videoBitsPerSecond: 8_000_000 } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    rec.start(250);
    return Promise.resolve(
      () =>
        new Promise<void>((resolve) => {
          rec.onstop = () => {
            const blob = new Blob(chunks, { type: rec.mimeType || 'video/webm' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `${shot.name.replace(/[^\w.-]+/g, '_') || 'shot'}.webm`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 4000);
            for (const t of stream.getTracks()) t.stop();
            resolve();
          };
          rec.stop();
        }),
    );
  },
};

export interface PlayerEvents extends Record<string, unknown> {
  change: undefined;
}

export class ShotPlayer extends Emitter<PlayerEvents> {
  shotId: string | null = null;
  t = 0;
  playing = false;
  recording = false;
  speed = 1;
  private saved: ReturnType<CameraRig['currentView']> | null = null;
  private curves = new WeakMap<object, PathCurve>();
  private stopRecording: (() => Promise<void>) | null = null;
  private pose: Pose = newPose();

  constructor(
    private app: App,
    private rig: CameraRig,
  ) {
    super();
  }

  get shot(): CameraShot | null {
    return this.app.store.cameras.shots.find((s) => s.id === this.shotId) ?? null;
  }

  private env: ShotEnv = {
    curve: (pathId) => {
      const p = this.app.store.path(pathId);
      if (!p) return null;
      let c = this.curves.get(p);
      if (!c) this.curves.set(p, (c = pathCurveOf(p)));
      return c;
    },
    bodyPosition: (id) => this.app.sim.poseOf(id)?.position ?? null,
  };

  /** Start (or switch) a preview session on a shot, paused at its first frame. */
  open(id: string): boolean {
    const shot = this.app.store.cameras.shots.find((s) => s.id === id);
    if (!shot) return false;
    if (!this.app.store.path(shot.pathId)) {
      this.app.toast(`Shot “${shot.name}” needs a path: pick one in the shot's settings`, 'warn');
      return false;
    }
    if (this.shotId === id) return true; // already previewing it: keep the playhead
    if (this.rig.driven) this.rig.setMode('orbit');
    if (!this.shotId) this.saved = this.rig.currentView();
    this.shotId = id;
    this.t = 0;
    this.playing = false;
    this.rig.override = (dt, out) => this.step(dt, out);
    this.rig.syncControls();
    this.emit('change', undefined);
    return true;
  }

  play(): void {
    if (!this.shot) return;
    const s = this.shot;
    if (!s.loop && this.t >= s.duration) this.t = 0;
    this.playing = true;
    this.emit('change', undefined);
  }

  pause(): void {
    this.playing = false;
    this.emit('change', undefined);
  }

  seek(t: number): void {
    const s = this.shot;
    if (!s) return;
    this.t = Math.max(0, Math.min(s.duration, t));
    this.emit('change', undefined);
  }

  /** End the session and glide back to the view the camera had before it. */
  close(): void {
    if (!this.shotId) return;
    void this.stopRecord();
    this.shotId = null;
    this.playing = false;
    this.rig.override = null;
    if (this.saved) {
      this.rig.recall(this.saved);
      this.saved = null;
    }
    this.emit('change', undefined);
  }

  private step(dt: number, out: Pose): boolean {
    const s = this.shot;
    if (!s) {
      this.shotId = null;
      this.emit('change', undefined);
      return false;
    }
    if (this.playing) {
      this.t += dt * this.speed;
      if (this.t >= s.duration) {
        if (s.loop) this.t %= s.duration;
        else {
          this.t = s.duration;
          this.playing = false;
          void this.stopRecord();
          this.emit('change', undefined);
        }
      }
    }
    if (!shotPose(s, this.t, this.env, this.pose)) {
      this.app.toast(`The path of “${s.name}” is gone`, 'warn');
      this.shotId = null;
      this.emit('change', undefined);
      return false;
    }
    out.position.copy(this.pose.position);
    out.quaternion.copy(this.pose.quaternion);
    out.fov = this.pose.fov;
    return true;
  }

  // ---- recording -------------------------------------------------------------------------------

  /** Play the shot from its start while recording; the file is delivered when it ends (or on `stopRecord`). */
  async record(recorderId = 'webm'): Promise<boolean> {
    const shot = this.shot;
    const rec = shotRecorders.get(recorderId);
    if (!shot || !rec) return false;
    if (!rec.available()) {
      this.app.toast('Video recording is not available in this browser', 'warn');
      return false;
    }
    this.app.viewport.viewHelperVisible = false;
    this.stopRecording = await rec.start(this.app, shot);
    this.recording = true;
    this.t = 0;
    this.playing = true;
    this.emit('change', undefined);
    return true;
  }

  async stopRecord(): Promise<void> {
    if (!this.recording) return;
    this.recording = false;
    this.app.viewport.viewHelperVisible = true;
    const stop = this.stopRecording;
    this.stopRecording = null;
    this.emit('change', undefined);
    await stop?.();
  }
}
