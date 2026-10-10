// -- DT-2: the capture session (viewport → WebM/MP4 via MediaRecorder, or animated GIF) --
/**
 * Lazy-loaded by the capture commands (`src/ui/extensions/capture.ts`); this module and the GIF encoder are not in
 * the main bundle.
 *
 * Two ways to drive a capture:
 *  - **real time**: the app runs as usual and frames are taken from the viewport's render loop at wall-clock times
 *    (what MediaRecorder needs anyway). A slow machine produces a choppy clip.
 *  - **deterministic**: the live loop is paused (the simulation is held in the paused state) and every output frame
 *    is produced by `planFrames`: advance the simulation by the planned number of fixed steps through
 *    `SimController.step`, wait for the worker's reply, let the viewport render, copy the canvas. The result
 *    depends on the scene and the plan only, not on how fast the machine renders.
 *
 * Pixels are read in the viewport's `afterRender` hook (the WebGL canvas does not preserve its drawing buffer, so
 * the copy has to happen in the same task as the render).
 */
import type { App } from '../app';
import { GifEncoder } from './gif';
import {
  gifDelays,
  hashBytes,
  outputHeight,
  planFrames,
  validateOptions,
  type CaptureFormat,
  type CaptureOptions,
  type FramePlan,
} from './scheduler';
import { turntableAngle, turntableOffset, turntablePose, type V3 } from './turntable';
import { Box3, Vector3 } from 'three';

export interface CaptureProgress {
  phase: 'preparing' | 'capturing' | 'encoding' | 'finishing';
  frame: number;
  total: number;
  /** Seconds of output captured so far. */
  seconds: number;
}

export interface CaptureResult {
  blob: Blob;
  filename: string;
  format: CaptureFormat;
  mime: string;
  frames: number;
  width: number;
  height: number;
  /** FNV-1a hash of every captured frame's RGBA pixels (GIF always; video only while a test hook is active). */
  hashes: string[];
  /** The capture was ended early with Stop. */
  stoppedEarly: boolean;
}

/** Thrown by `run()` after `cancel()`. */
export class CaptureCancelled extends Error {
  constructor() {
    super('Capture cancelled');
    this.name = 'CaptureCancelled';
  }
}

/** Thrown when the capture cannot start; the message is shown to the user as is. */
export class CaptureUnavailable extends Error {}

const VIDEO_MIMES: Record<'webm' | 'mp4', string[]> = {
  webm: ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm;codecs=av1', 'video/webm'],
  mp4: ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4;codecs=h264', 'video/mp4'],
};

/** Which video containers this browser's MediaRecorder can write, with the MIME type to use for each. */
export function detectVideoSupport(): { webm: string | null; mp4: string | null; reason: string | null } {
  if (typeof MediaRecorder === 'undefined' || typeof HTMLCanvasElement === 'undefined')
    return {
      webm: null,
      mp4: null,
      reason: 'This browser has no MediaRecorder, so video recording is unavailable. GIF still works.',
    };
  if (typeof HTMLCanvasElement.prototype.captureStream !== 'function')
    return {
      webm: null,
      mp4: null,
      reason:
        'This browser cannot stream a canvas (captureStream), so video recording is unavailable. GIF still works.',
    };
  const pick = (list: string[]) => list.find((m) => MediaRecorder.isTypeSupported(m)) ?? null;
  return { webm: pick(VIDEO_MIMES.webm), mp4: pick(VIDEO_MIMES.mp4), reason: null };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Waiter {
  pred: () => boolean;
  resolve: () => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CaptureSession {
  private state: 'idle' | 'running' | 'stopping' | 'cancelled' = 'idle';
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private waiters: Waiter[] = [];
  private width = 0;
  private height = 0;
  /** Turntable state. */
  private orbit: { target: V3; offset: V3 } | null = null;

  constructor(
    private app: App,
    readonly options: CaptureOptions,
    private onProgress: (p: CaptureProgress) => void = () => undefined,
  ) {}

  get running(): boolean {
    return this.state === 'running';
  }

  /** Abort and discard everything. */
  cancel(): void {
    if (this.state === 'running' || this.state === 'stopping') this.state = 'cancelled';
    this.flushWaiters(new CaptureCancelled());
  }

  /** End now and keep what was captured so far. */
  stop(): void {
    if (this.state === 'running') this.state = 'stopping';
  }

  private get cancelled(): boolean {
    return this.state === 'cancelled';
  }

  private get live(): boolean {
    return this.state === 'running';
  }

  async run(): Promise<CaptureResult> {
    if (this.state !== 'idle') throw new Error('A capture session can only run once');
    const { app, options: o } = this;
    const vp = app.viewport;
    const check = validateOptions(o, vp.dom.width, vp.dom.height);
    if (check.errors.length) throw new CaptureUnavailable(check.errors.join(' '));
    this.width = check.value.width;
    this.height = outputHeight(this.width, vp.dom.width, vp.dom.height);
    let mime = 'image/gif';
    if (o.format !== 'gif') {
      const sup = detectVideoSupport();
      if (sup.reason) throw new CaptureUnavailable(sup.reason);
      const m = sup[o.format];
      if (!m) {
        const other = o.format === 'webm' ? sup.mp4 && 'MP4' : sup.webm && 'WebM';
        throw new CaptureUnavailable(
          `This browser cannot record ${o.format.toUpperCase()} (MediaRecorder.isTypeSupported says no for every ${o.format.toUpperCase()} codec).` +
            (other ? ` Choose ${other} or GIF instead.` : ' Choose GIF instead.'),
        );
      }
      mime = m;
    }

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    const ctx = this.canvas.getContext('2d', { willReadFrequently: o.format === 'gif' });
    if (!ctx) throw new CaptureUnavailable('Could not create a 2D canvas for the capture.');
    this.ctx = ctx;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // Saved state, restored in `finally`.
    const savedView = vp.getView();
    const savedControls = vp.controls.enabled;
    const prevHook = vp.afterRender;
    const prevMode = app.sim.mode;
    let simTouched = false;
    this.state = 'running';
    vp.afterRender = (c) => this.onRendered(c);
    try {
      this.onProgress({ phase: 'preparing', frame: 0, total: check.frames, seconds: 0 });
      if (o.turntable) {
        vp.controls.enabled = false;
        this.orbit = this.computeOrbit();
      }
      const needsSim = o.deterministic ? !(o.turntable && o.pauseSim) : false;
      if (o.turntable && o.pauseSim && app.sim.mode === 'running') {
        app.sim.pause();
        simTouched = true;
      }
      if (needsSim) {
        simTouched = true;
        await this.prepareSim(o.restart);
      }
      const plan = planFrames({
        fps: check.value.fps,
        duration: o.duration,
        physicsHz: app.store.settings.physicsHz,
        timeScale: app.sim.timeScale,
      });
      if (!this.live) throw new CaptureCancelled();
      if (o.format === 'gif')
        return await (o.deterministic ? this.gifDeterministic(plan, needsSim) : this.gifRealtime(plan));
      return await this.video(plan, mime, needsSim);
    } finally {
      vp.afterRender = prevHook;
      vp.controls.enabled = savedControls;
      if (o.turntable) vp.setView(savedView);
      if (simTouched) this.restoreSim(prevMode);
      this.flushWaiters(new CaptureCancelled());
      if (!this.cancelled) this.state = 'idle';
    }
  }

  // ---- viewport / frame plumbing ---------------------------------------------------------------

  /** Runs inside the viewport's render task: copy the canvas and release whoever waits for this render. */
  private onRendered(source: HTMLCanvasElement): void {
    if (!this.waiters.length) return;
    let copied = false;
    const still: Waiter[] = [];
    for (const w of this.waiters) {
      if (w.pred()) {
        if (!copied) {
          this.ctx.drawImage(source, 0, 0, this.width, this.height);
          copied = true;
        }
        clearTimeout(w.timer);
        w.resolve();
      } else still.push(w);
    }
    this.waiters = still;
  }

  /** Resolve at the first render for which `pred()` holds; the canvas has been copied into the work canvas by then. */
  private waitRender(pred: () => boolean = () => true, timeoutMs = 20000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const w: Waiter = {
        pred,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((x) => x !== w);
          reject(
            new CaptureUnavailable(
              'The viewport stopped rendering (is this tab in the background?) or the simulation stopped answering. Keep the tab visible while capturing.',
            ),
          );
        }, timeoutMs),
      };
      this.waiters.push(w);
    });
  }

  private flushWaiters(e: Error): void {
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.reject(e);
    }
    this.waiters = [];
  }

  private rgba(): ImageData {
    return this.ctx.getImageData(0, 0, this.width, this.height);
  }

  // ---- simulation ----------------------------------------------------------------------------------

  private simTarget = 0;

  private async prepareSim(restart: boolean): Promise<void> {
    const { sim } = this.app;
    if (restart && sim.mode !== 'edit') sim.reset();
    sim.step(0); // builds the world when there is none and leaves it paused
    if (sim.mode === 'running') sim.pause();
    await this.waitRender(() => sim.client.frameNo > 0 && !!sim.client.stats);
    this.simTarget = sim.client.stats?.stepCount ?? 0;
  }

  private restoreSim(prev: 'edit' | 'paused' | 'running'): void {
    const { sim } = this.app;
    if (prev === 'edit') sim.reset();
    else if (prev === 'running') sim.play();
  }

  /** Make the simulation reach `simTarget` steps; resolves at the render that shows it. */
  private advance(steps: number): Promise<void> {
    const { sim } = this.app;
    this.simTarget += steps;
    if (steps > 0) sim.step(steps);
    return this.waitRender(() => (sim.client.stats?.stepCount ?? 0) >= this.simTarget);
  }

  // ---- turntable ---------------------------------------------------------------------------------------

  private computeOrbit(): { target: V3; offset: V3 } {
    const { app } = this;
    const box = new Box3();
    const addView = (id: string) => {
      const v = app.bodies.get(id);
      if (v) {
        box.expandByObject(v.mesh);
        return true;
      }
      const sm = app.softs.meshOf(id);
      if (sm) {
        box.expandByObject(sm);
        return true;
      }
      return false;
    };
    let any = false;
    if (this.options.turntableTarget === 'selection') for (const id of app.store.selection) any = addView(id) || any;
    if (!any) {
      for (const [id, v] of app.bodies.views) if (!v.def.hidden) any = addView(id) || any;
      for (const [id, sv] of app.softs.views) if (!sv.def.hidden) any = addView(id) || any;
    }
    const cam = app.viewport.camera.position;
    const tgt = app.viewport.controls.target;
    const center = new Vector3();
    let radius = 3;
    if (any && !box.isEmpty()) {
      box.getCenter(center);
      radius = Math.min(60, Math.max(1, box.getSize(new Vector3()).length() / 2));
    } else center.copy(tgt);
    const offset = turntableOffset(
      [cam.x - center.x, cam.y - center.y, cam.z - center.z],
      radius,
      app.viewport.camera.fov,
    );
    return { target: [center.x, center.y, center.z], offset };
  }

  private poseTurntable(angle: number): void {
    if (!this.orbit) return;
    const p = turntablePose(this.orbit.target, this.orbit.offset, angle);
    this.app.viewport.setView(p);
  }

  // ---- GIF ----------------------------------------------------------------------------------------------

  private async gifDeterministic(plan: FramePlan, simDriven: boolean): Promise<CaptureResult> {
    const { options: o } = this;
    const enc = new GifEncoder(this.width, this.height);
    const delays = gifDelays(this.optionsFps(), plan.count);
    const hashes: string[] = [];
    for (const f of plan.frames) {
      if (!this.live) break;
      if (o.turntable) this.poseTurntable(turntableAngle(f.index, plan.count));
      if (simDriven) await this.advance(f.steps);
      else await this.waitRender();
      const data = this.rgba().data;
      hashes.push(hashBytes(data));
      this.onProgress({
        phase: 'capturing',
        frame: f.index + 1,
        total: plan.count,
        seconds: (f.index + 1) / this.optionsFps(),
      });
      enc.addFrame(data, delays[f.index]);
      await tick(); // let the page breathe between encoded frames
    }
    return this.finishGif(enc, hashes);
  }

  private async gifRealtime(plan: FramePlan): Promise<CaptureResult> {
    const { options: o } = this;
    const fps = this.optionsFps();
    const frames: Uint8ClampedArray[] = [];
    const stamps: number[] = [];
    const hashes: string[] = [];
    const t0 = performance.now();
    for (let i = 0; i < plan.count && this.live; i++) {
      const due = t0 + (i / fps) * 1000;
      await this.waitRender(() => performance.now() >= due);
      if (o.turntable) {
        // Pose for the *next* render, from the wall clock, so the revolution takes `duration` seconds.
        this.poseTurntable(((performance.now() - t0) / 1000 / o.duration) * 2 * Math.PI);
      }
      const data = this.rgba().data;
      frames.push(data);
      stamps.push(performance.now());
      this.onProgress({
        phase: 'capturing',
        frame: i + 1,
        total: plan.count,
        seconds: (performance.now() - t0) / 1000,
      });
    }
    // Delays follow the measured capture times, so a slow machine still plays back at real-world speed.
    const enc = new GifEncoder(this.width, this.height);
    const nominal = gifDelays(fps, plan.count);
    for (let i = 0; i < frames.length; i++) {
      if (this.cancelled) throw new CaptureCancelled();
      const delay = i + 1 < frames.length ? Math.round((stamps[i + 1] - stamps[i]) / 10) : nominal[i];
      hashes.push(hashBytes(frames[i]));
      enc.addFrame(frames[i], Math.max(2, delay));
      frames[i] = new Uint8ClampedArray(0); // free the pixels as we go
      this.onProgress({ phase: 'encoding', frame: i + 1, total: frames.length, seconds: 0 });
      await tick();
    }
    return this.finishGif(enc, hashes);
  }

  private finishGif(enc: GifEncoder, hashes: string[]): CaptureResult {
    if (this.cancelled) throw new CaptureCancelled();
    if (enc.frameCount === 0) throw new CaptureCancelled();
    const parts = enc.finishParts();
    return this.result(new Blob(parts as BlobPart[], { type: 'image/gif' }), 'image/gif', enc.frameCount, hashes);
  }

  // ---- video ----------------------------------------------------------------------------------------------

  private async video(plan: FramePlan, mime: string, simDriven: boolean): Promise<CaptureResult> {
    const { options: o } = this;
    const fps = this.optionsFps();
    // Deterministic: a frame is pushed explicitly after each planned step; real time: the canvas streams by itself.
    const stream = this.canvas.captureStream(o.deterministic ? 0 : fps);
    const track = stream.getVideoTracks()[0] as (MediaStreamTrack & { requestFrame?: () => void }) | undefined;
    const bits = Math.round(Math.min(25e6, Math.max(2e6, this.width * this.height * fps * 0.12)));
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bits });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    const stopped = new Promise<void>((resolve, reject) => {
      rec.onstop = () => resolve();
      rec.onerror = () => reject(new Error('MediaRecorder reported an error while recording.'));
    });
    const hashes: string[] = [];
    const hashing = !!window.__downloadHook;
    let drawn = 0; // frames actually captured
    try {
      // Paint the first picture before recording starts, so the stream has a frame to begin with.
      await this.waitRender();
      rec.start(500);
      const t0 = performance.now();
      if (o.deterministic) {
        for (const f of plan.frames) {
          if (!this.live) break;
          if (o.turntable) this.poseTurntable(turntableAngle(f.index, plan.count));
          const tFrame = performance.now();
          if (simDriven) await this.advance(f.steps);
          else await this.waitRender();
          if (hashing) hashes.push(hashBytes(this.rgba().data));
          drawn = f.index + 1;
          track?.requestFrame?.();
          this.onProgress({ phase: 'capturing', frame: f.index + 1, total: plan.count, seconds: (f.index + 1) / fps });
          // MediaRecorder stamps frames with the wall clock: hold each frame for its nominal duration so the clip plays at `fps`.
          await sleep(Math.max(0, 1000 / fps - (performance.now() - tFrame)));
        }
      } else {
        let frame = 0; // renders seen
        const total = o.duration * 1000;
        while (this.live && performance.now() - t0 < total) {
          await this.waitRender();
          frame++;
          drawn = frame;
          if (o.turntable) this.poseTurntable(((performance.now() - t0) / total) * 2 * Math.PI);
          this.onProgress({
            phase: 'capturing',
            frame,
            total: Math.round(o.duration * fps),
            seconds: (performance.now() - t0) / 1000,
          });
        }
      }
      this.onProgress({ phase: 'finishing', frame: plan.count, total: plan.count, seconds: o.duration });
      // Give the encoder time to take the last picture before the stream ends. A busy machine can take seconds before the encoder emits anything: wait (bounded) for the first data.
      track?.requestFrame?.();
      await sleep(Math.max(300, 2000 / fps));
      for (let waited = 0; waited < 8000 && !this.cancelled && !chunks.length; waited += 100) {
        track?.requestFrame?.();
        await sleep(100);
      }
      if (rec.state !== 'inactive') rec.stop();
      await stopped;
    } finally {
      if (rec.state !== 'inactive') rec.stop();
      for (const t of stream.getTracks()) t.stop();
    }
    if (this.cancelled) throw new CaptureCancelled();
    const blob = new Blob(chunks, { type: mime.split(';')[0] });
    if (blob.size === 0) throw new CaptureUnavailable('The browser produced an empty recording.');
    return this.result(blob, mime.split(';')[0], drawn, hashes);
  }

  // ---- result ------------------------------------------------------------------------------------------------

  private optionsFps(): number {
    return Math.round(this.options.fps);
  }

  private result(blob: Blob, mime: string, frames: number, hashes: string[]): CaptureResult {
    const o = this.options;
    const name = (this.app.store.name || 'scene').replace(/[^\w-]+/g, '_').slice(0, 40) || 'scene';
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    return {
      blob,
      filename: `physixlab-${name}${o.turntable ? '-turntable' : ''}-${stamp}.${o.format}`,
      format: o.format,
      mime,
      frames,
      width: this.width,
      height: this.height,
      hashes,
      stoppedEarly: this.state === 'stopping',
    };
  }
}
