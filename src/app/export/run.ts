/**
 * The export actions the File menu commands call (loaded on first use: this module and everything it imports —
 * the writers, the geometry provider, the image capture — form a separate chunk). Each function reads the live
 * document, builds the file, hands it to `downloadBlob` and reports with a toast; it returns a short summary.
 */
import type { App } from '../app';
import { renderImage, type ImageOptions } from './capture';
import { downloadBlob, fileStem } from './download';
import { buildGlb } from './gltf';
import { buildObj } from './obj';
import { buildExportScene, triangleCount } from './scene';
import { buildStl } from './stl';
import { createThreeGeometryProvider } from './threeGeometry';
import type { AnimationFrames, ExportScene, Pose, SceneExportOptions } from './types';
import { buildZip } from './zip';

export interface ModelExportOptions {
  /** Only the selected entities (and members of selected groups). */
  selectionOnly: boolean;
  ground: boolean;
}

export interface GlbExportOptions extends ModelExportOptions {
  /** Bake the motion of the running simulation for this many seconds (0 = static scene). */
  animateSeconds: number;
}

export interface ObjExportOptions extends ModelExportOptions {
  /** Download a .zip with the .obj and its .mtl (otherwise just the .obj, without material colours). */
  withMaterials: boolean;
}

export interface StlExportOptions extends ModelExportOptions {
  millimetres: boolean;
  zUp: boolean;
}

export interface PngExportOptions {
  width: number;
  height: number;
  transparent: boolean;
  helpers: boolean;
}

function sceneFor(app: App, o: ModelExportOptions, extra: Partial<SceneExportOptions> = {}): ExportScene | null {
  const doc = app.store.toDocument();
  const ids = o.selectionOnly ? app.store.selection : undefined;
  if (ids && ids.length === 0) {
    app.toast('Nothing is selected. Select something first, or export the whole scene.', 'warn');
    return null;
  }
  const provider = createThreeGeometryProvider();
  return buildExportScene(doc, provider, { ids, ground: o.ground, ...extra });
}

function reportSkipped(app: App, scene: ExportScene): string {
  if (scene.skipped.length === 0) return '';
  const soft = scene.skipped.filter((s) => /soft bod/.test(s.reason)).length;
  const other = scene.skipped.length - soft;
  const parts: string[] = [];
  if (soft > 0) parts.push(`${soft} soft ${soft === 1 ? 'body' : 'bodies'}`);
  if (other > 0) parts.push(`${other} other item${other === 1 ? '' : 's'}`);
  const text = `${parts.join(' and ')} could not be exported`;
  app.toast(`${text} (soft bodies are simulated particles, not meshes).`, 'warn');
  return text;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Sample the poses of the scene's bodies about 30 times a second for `seconds` while the simulation runs. */
export async function recordPoses(app: App, scene: ExportScene, seconds: number): Promise<AnimationFrames> {
  const ids: string[] = [];
  const visit = (n: ExportScene['roots'][number]): void => {
    if (n.entityId && app.store.body(n.entityId)) ids.push(n.entityId);
    n.children.forEach(visit);
  };
  scene.roots.forEach(visit);
  const times: number[] = [];
  const poses = new Map<string, Pose[]>(ids.map((id) => [id, []]));
  const startedHere = !app.sim.active || app.sim.mode === 'paused';
  if (startedHere) app.sim.play();
  // The physics worker needs a moment to start: begin the clock at its first frame (at most 15 s).
  const wait0 = performance.now();
  while (app.sim.client.frameNo === 0 && performance.now() - wait0 < 15000) await sleep(20);
  const t0 = performance.now();
  const interval = 1000 / 30;
  let next = 0;
  for (;;) {
    const t = (performance.now() - t0) / 1000;
    if (t >= next) {
      times.push(Math.round(t * 1000) / 1000);
      for (const id of ids) {
        const p = app.sim.poseOf(id);
        const list = poses.get(id);
        if (p && list) list.push({ position: [...p.position], rotation: [...p.rotation] });
        else if (list) list.push(list[list.length - 1] ?? { position: [0, 0, 0], rotation: [0, 0, 0, 1] });
      }
      next = t + interval / 1000;
    }
    if (t >= seconds) break;
    await sleep(Math.max(1, interval / 2));
  }
  if (startedHere) app.sim.pause();
  return { times, poses };
}

export async function exportGlb(app: App, o: GlbExportOptions): Promise<string | null> {
  const scene = sceneFor(app, o);
  if (!scene) return null;
  let animation: AnimationFrames | undefined;
  if (o.animateSeconds > 0) {
    app.toast(`Recording ${o.animateSeconds} s of the simulation …`, 'info');
    animation = await recordPoses(app, scene, o.animateSeconds);
  }
  const { glb, animatedChannels } = buildGlb(scene, { animation });
  const name = `${fileStem(app.store.name)}.glb`;
  downloadBlob(name, new Blob([glb as BlobPart], { type: 'model/gltf-binary' }));
  const skipped = reportSkipped(app, scene);
  const tris = triangleCount(scene);
  const anim = animation
    ? animatedChannels > 0
      ? ` with ${animation.times.length} animation frames`
      : ' (nothing moved, no animation)'
    : '';
  const text = `Exported ${name}: ${tris.toLocaleString()} triangles${anim}`;
  app.toast(text + (skipped ? '' : '.'), 'success');
  return text;
}

export function exportObj(app: App, o: ObjExportOptions): string | null {
  const scene = sceneFor(app, o, { lights: false });
  if (!scene) return null;
  const stem = fileStem(app.store.name);
  const res = buildObj(scene, { mtlName: `${stem}.mtl`, materials: o.withMaterials });
  const enc = new TextEncoder();
  let name: string;
  if (o.withMaterials) {
    name = `${stem}.obj.zip`;
    const zip = buildZip([
      { name: `${stem}.obj`, data: enc.encode(res.obj) },
      { name: `${stem}.mtl`, data: enc.encode(res.mtl) },
    ]);
    downloadBlob(name, new Blob([zip as BlobPart], { type: 'application/zip' }));
  } else {
    name = `${stem}.obj`;
    downloadBlob(name, new Blob([res.obj], { type: 'text/plain' }));
  }
  reportSkipped(app, scene);
  const text = `Exported ${name}: ${res.triangleCount.toLocaleString()} triangles`;
  app.toast(`${text}.`, 'success');
  return text;
}

export function exportStl(app: App, o: StlExportOptions): string | null {
  const scene = sceneFor(app, o, { lights: false });
  if (!scene) return null;
  const res = buildStl(scene, { scale: o.millimetres ? 1000 : 1, zUp: o.zUp });
  if (res.triangleCount === 0) {
    app.toast('There is nothing to export: no visible solid objects.', 'warn');
    return null;
  }
  const name = `${fileStem(app.store.name)}.stl`;
  downloadBlob(name, new Blob([res.data as BlobPart], { type: 'model/stl' }));
  reportSkipped(app, scene);
  const text = `Exported ${name}: ${res.triangleCount.toLocaleString()} triangles in ${o.millimetres ? 'millimetres' : 'metres'}`;
  app.toast(`${text}.`, 'success');
  return text;
}

export async function exportPng(app: App, o: PngExportOptions): Promise<string | null> {
  const opts: ImageOptions = { width: o.width, height: o.height, transparent: o.transparent, helpers: o.helpers };
  const blob = await renderImage(app, opts);
  const name = `${fileStem(app.store.name)}-${o.width}x${o.height}.png`;
  downloadBlob(name, blob);
  const text = `Saved ${name} (${(blob.size / 1024).toFixed(0)} KB)`;
  app.toast(`${text}.`, 'success');
  return text;
}
