/**
 * Generated thumbnails of the shapes for the Add palette: each shape is drawn once, at its default size, with a
 * small offscreen three.js renderer, and the picture is cached as a data URL (`thumbCache.ts`) so it is drawn only
 * once per browser. Pictures are made one per timer tick, so opening the palette never stalls the page, and the
 * renderer (a WebGL context) is released a moment after the last one. Without WebGL the palette keeps its icons.
 */
import type { BufferGeometry } from 'three';
import {
  ACESFilmicToneMapping,
  Box3,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Sphere,
  Vector3,
  WebGLRenderer,
} from 'three';
import { makeShapeSpec, shapeGeometry, shapeGeometryKey, shapeVisualScale, shapeVolume } from '../model/shapeRegistry';
import type { ShapeDef } from '../model/shapeRegistry';
import type { ShapeSpec } from '../model/types';
import { GEOMETRY_KIT } from './geometryKit';
import { applyShapeSurface, surfaceTexture } from './shapeSurface';
import { ThumbCache } from './thumbCache';

/** Pixels of a thumbnail (it is shown at half this size, for sharp edges on dense screens). */
export const THUMB_PX = 72;
/** Bump when the look of the thumbnails changes: every stored picture is then redrawn. */
export const THUMB_VERSION = 3;

const cache = new ThumbCache(
  (() => {
    try {
      return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
      return null;
    }
  })(),
  'physicslab.shapeThumb.',
);

/** What a thumbnail was made from: it is redrawn when any of this changes. */
export function thumbnailFingerprint(def: ShapeDef): string {
  const spec = makeShapeSpec(def.id);
  return [
    `v${THUMB_VERSION}`,
    def.id,
    shapeGeometryKey(spec),
    spec.size.map((v) => v.toFixed(4)).join(','),
    shapeVolume(spec).toPrecision(8),
  ].join('|');
}

/** The thumbnail if it has been drawn (this session or an earlier one), else null. */
export function cachedThumbnail(def: ShapeDef): string | null {
  try {
    return cache.get(def.id, thumbnailFingerprint(def));
  } catch {
    return null;
  }
}

class ThumbRenderer {
  readonly renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(28, 1, 0.01, 100);

  constructor() {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(1);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.scene.add(new HemisphereLight(0xdfeaff, 0x3b4452, 1.35));
    const key = new DirectionalLight(0xfff3e0, 2.9);
    key.position.set(3, 5, 4);
    const fill = new DirectionalLight(0x9ec5ff, 0.8);
    fill.position.set(-4, 1.5, -2);
    this.scene.add(key, fill);
  }

  /**
   * One material per kind of surface, kept for the renderer's lifetime: the engine deletes a shader program when the
   * last material using it is disposed, and compiling it again for every thumbnail is by far the slowest part.
   */
  private materials = new Map<string, MeshStandardMaterial>();

  private materialFor(geo: BufferGeometry, spec: ShapeSpec): MeshStandardMaterial {
    const key = `${geo.hasAttribute('color') ? 'colors' : 'plain'}|${surfaceTexture(spec) ? 'painted' : 'flat'}`;
    let material = this.materials.get(key);
    if (!material) {
      material = new MeshStandardMaterial({ color: '#a9bdd9', roughness: 0.5, metalness: 0.05 });
      this.materials.set(key, material);
    }
    applyShapeSurface(material, geo, spec);
    return material;
  }

  /** Draw the shape into the viewport/scissor rectangle (x, y from the bottom-left) of the canvas. */
  private drawTile(def: ShapeDef, x: number, y: number): void {
    const spec = makeShapeSpec(def.id);
    const geo = shapeGeometry(GEOMETRY_KIT, spec);
    const material = this.materialFor(geo, spec);
    const mesh = new Mesh(geo, material);
    const s = shapeVisualScale(spec);
    mesh.scale.set(s[0], s[1], s[2]);
    this.scene.add(mesh);
    mesh.updateMatrixWorld(true);
    const box = new Box3().setFromObject(mesh);
    const sphere = box.getBoundingSphere(new Sphere());
    // look from the front-right and above, far enough that the bounding sphere fills ~85 % of the frame
    const dir = new Vector3(0.78, 0.62, 1).normalize();
    const dist = (sphere.radius / Math.sin((this.camera.fov * Math.PI) / 360)) * 1.08;
    this.camera.position.copy(sphere.center).addScaledVector(dir, dist);
    this.camera.near = Math.max(0.01, dist - sphere.radius * 2);
    this.camera.far = dist + sphere.radius * 2;
    this.camera.lookAt(sphere.center);
    this.camera.updateProjectionMatrix();
    this.renderer.setViewport(x, y, THUMB_PX, THUMB_PX);
    this.renderer.setScissor(x, y, THUMB_PX, THUMB_PX);
    this.renderer.render(this.scene, this.camera);
    this.scene.remove(mesh);
    geo.dispose();
  }

  /**
   * Pictures of several shapes. They are drawn side by side on one canvas and cut apart on the CPU: reading a
   * WebGL canvas back waits for the graphics process, so one read for the whole batch is far cheaper than one each.
   */
  drawBatch(defs: readonly ShapeDef[]): string[] {
    const cols = Math.min(defs.length, 6);
    const rows = Math.ceil(defs.length / cols);
    this.renderer.setSize(cols * THUMB_PX, rows * THUMB_PX, false);
    this.renderer.setScissorTest(true);
    this.renderer.setClearColor(0x000000, 0);
    // clear the whole canvas once: the per-tile renders only clear their scissor
    this.renderer.setScissor(0, 0, cols * THUMB_PX, rows * THUMB_PX);
    this.renderer.setViewport(0, 0, cols * THUMB_PX, rows * THUMB_PX);
    this.renderer.clear();
    defs.forEach((def, i) => this.drawTile(def, (i % cols) * THUMB_PX, (rows - 1 - Math.floor(i / cols)) * THUMB_PX));
    const atlas = document.createElement('canvas');
    atlas.width = cols * THUMB_PX;
    atlas.height = rows * THUMB_PX;
    const actx = atlas.getContext('2d');
    if (!actx) throw new Error('2d canvas unavailable');
    actx.drawImage(this.renderer.domElement, 0, 0); // the single read-back
    return defs.map((_, i) => {
      const tile = document.createElement('canvas');
      tile.width = tile.height = THUMB_PX;
      const ctx = tile.getContext('2d');
      if (!ctx) throw new Error('2d canvas unavailable');
      ctx.drawImage(
        atlas,
        (i % cols) * THUMB_PX,
        Math.floor(i / cols) * THUMB_PX,
        THUMB_PX,
        THUMB_PX,
        0,
        0,
        THUMB_PX,
        THUMB_PX,
      );
      return tile.toDataURL('image/webp', 0.92);
    });
  }

  dispose(): void {
    for (const m of this.materials.values()) m.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

interface Job {
  def: ShapeDef;
  waiting: ((url: string) => void)[];
}

const queue: Job[] = [];
let renderer: ThumbRenderer | null = null;
let broken = false;
let pumping = false;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

/** Shapes drawn per timer tick (and per read-back). */
const BATCH = 12;

function pump(): void {
  const jobs = queue.splice(0, BATCH);
  if (!jobs.length) {
    pumping = false;
    // release the WebGL context a moment after the last picture
    idleTimer = setTimeout(() => {
      renderer?.dispose();
      renderer = null;
    }, 1500);
    return;
  }
  try {
    renderer ??= new ThumbRenderer();
    const urls = renderer.drawBatch(jobs.map((j) => j.def));
    jobs.forEach((job, i) => {
      cache.set(job.def.id, thumbnailFingerprint(job.def), urls[i]);
      for (const f of job.waiting) f(urls[i]);
    });
  } catch {
    broken = true; // no WebGL here: keep the icons
    queue.length = 0;
  }
  setTimeout(pump, 0);
}

/**
 * Ask for the thumbnail of a shape. `onReady` runs with the picture — at once when it is cached, else after it has
 * been drawn — and never when thumbnails are unavailable.
 */
export function requestThumbnail(def: ShapeDef, onReady: (url: string) => void): void {
  const hit = cachedThumbnail(def);
  if (hit) {
    onReady(hit);
    return;
  }
  if (broken) return;
  const queued = queue.find((j) => j.def.id === def.id);
  if (queued) queued.waiting.push(onReady);
  else queue.push({ def, waiting: [onReady] });
  clearTimeout(idleTimer);
  if (!pumping) {
    pumping = true;
    setTimeout(pump, 0);
  }
}
