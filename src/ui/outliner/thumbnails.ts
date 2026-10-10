/**
 * UI-A: per-row thumbnails — small real renders of a body's shape, made off-screen with one shared three.js
 * renderer and cached by (geometry, material). Rows ask for a thumbnail synchronously: a cached one comes back
 * at once, otherwise the render is queued (a few per animation frame, so a long scene never blocks) and the
 * requester is called back. Where WebGL is unavailable the callers keep the icon.
 */
import {
  AmbientLight,
  DirectionalLight,
  Group,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Quaternion,
  Scene,
  Vector3,
  WebGLRenderer,
  type BufferGeometry,
} from 'three';
import { isCompound } from '../../model/compound';
import { shapeGeometry, shapeGeometryKey, shapeVisualScale } from '../../model/shapeRegistry';
import type { BodyEntity, ShapeSpec } from '../../model/types';
import { GEOMETRY_KIT } from '../../render/geometryKit';

const PX = 56; // rendered at 2x for a 28 px row
const MAX_CACHE = 1500;
const PER_FRAME = 4;

interface Job {
  key: string;
  body: BodyEntity;
  waiting: ((url: string) => void)[];
}

export class ThumbnailCache {
  private readonly cache = new Map<string, string>();
  private readonly queue = new Map<string, Job>();
  private raf = 0;
  private failed = false;
  private gl: {
    renderer: WebGLRenderer;
    scene: Scene;
    camera: PerspectiveCamera;
    holder: Group;
    material: MeshStandardMaterial;
  } | null = null;
  /** Renders actually performed (cache misses) — exposed for tests. */
  renders = 0;

  /** Cache key of a body's look; bodies that look the same share one thumbnail. */
  static keyOf(b: BodyEntity): string {
    const m = b.material;
    const shapeKey = (s: ShapeSpec) => `${shapeGeometryKey(s)}@${s.size.map((v) => v.toFixed(2)).join(',')}`;
    const geo = isCompound(b)
      ? (b.parts ?? [])
          .filter((p) => p.visible !== false)
          .map((p) => `${shapeKey(p.shape)}+${p.position.join(',')}+${p.rotation.join(',')}`)
          .join('|')
      : shapeKey(b.shape);
    return `${geo}#${m.color}/${m.metalness.toFixed(1)}/${m.roughness.toFixed(1)}/${m.opacity.toFixed(1)}`;
  }

  /** A cached thumbnail data URL, or null (a render is then queued and `onReady` fires when it exists). */
  request(body: BodyEntity, onReady: (url: string) => void): string | null {
    if (this.failed) return null;
    const key = ThumbnailCache.keyOf(body);
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key); // LRU: re-insert as most recent
      this.cache.set(key, hit);
      return hit;
    }
    const job = this.queue.get(key);
    if (job) job.waiting.push(onReady);
    else this.queue.set(key, { key, body, waiting: [onReady] });
    if (!this.raf) this.raf = requestAnimationFrame(() => this.pump());
    return null;
  }

  get size(): number {
    return this.cache.size;
  }

  private pump(): void {
    this.raf = 0;
    let n = 0;
    for (const [key, job] of this.queue) {
      if (n++ >= PER_FRAME) break;
      this.queue.delete(key);
      const url = this.render(job.body);
      if (!url) {
        this.failed = true;
        this.queue.clear();
        return;
      }
      this.cache.set(key, url);
      if (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value as string);
      for (const w of job.waiting) w(url);
    }
    if (this.queue.size) this.raf = requestAnimationFrame(() => this.pump());
  }

  private ensureGl(): NonNullable<ThumbnailCache['gl']> | null {
    if (this.gl) return this.gl;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = PX;
      const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
      renderer.setPixelRatio(1);
      renderer.setSize(PX, PX, false);
      renderer.setClearColor(0x000000, 0);
      const scene = new Scene();
      scene.add(new AmbientLight(0xffffff, 1.6));
      const key = new DirectionalLight(0xffffff, 2.4);
      key.position.set(2, 3, 2.5);
      scene.add(key);
      const rim = new DirectionalLight(0x9db8ff, 0.8);
      rim.position.set(-2, -1, -2);
      scene.add(rim);
      const holder = new Group();
      scene.add(holder);
      const camera = new PerspectiveCamera(32, 1, 0.01, 1000);
      const material = new MeshStandardMaterial();
      this.gl = { renderer, scene, camera, holder, material };
      return this.gl;
    } catch {
      return null;
    }
  }

  private render(body: BodyEntity): string | null {
    const gl = this.ensureGl();
    if (!gl) return null;
    const { renderer, scene, camera, holder, material } = gl;
    const geos: BufferGeometry[] = [];
    try {
      const m = body.material;
      material.color.set(m.color);
      material.metalness = m.metalness;
      material.roughness = m.roughness;
      material.transparent = m.opacity < 1;
      material.opacity = Math.max(0.35, m.opacity);
      material.needsUpdate = true;
      const add = (shape: ShapeSpec, pos?: readonly number[], rot?: readonly number[]) => {
        const geo = shapeGeometry(GEOMETRY_KIT, shape);
        geos.push(geo);
        const mesh = new Mesh(geo, material);
        const s = shapeVisualScale(shape);
        mesh.scale.set(s[0], s[1], s[2]);
        if (pos) mesh.position.set(pos[0], pos[1], pos[2]);
        if (rot) mesh.quaternion.set(rot[0], rot[1], rot[2], rot[3]);
        holder.add(mesh);
      };
      if (isCompound(body)) {
        for (const p of body.parts ?? []) if (p.visible !== false) add(p.shape, p.position, p.rotation);
      } else add(body.shape);
      // Fit: look at the bounding sphere from a fixed three-quarter view.
      const box = new Vector3();
      let radius = 0;
      holder.updateMatrixWorld(true);
      const center = new Vector3();
      const bb = { min: new Vector3(Infinity, Infinity, Infinity), max: new Vector3(-Infinity, -Infinity, -Infinity) };
      for (const c of holder.children) {
        const mesh = c as Mesh;
        mesh.geometry.computeBoundingBox();
        const b = mesh.geometry.boundingBox;
        if (!b) continue;
        for (const x of [b.min.x, b.max.x])
          for (const y of [b.min.y, b.max.y])
            for (const z of [b.min.z, b.max.z]) {
              box.set(x, y, z).applyMatrix4(mesh.matrixWorld);
              bb.min.min(box);
              bb.max.max(box);
            }
      }
      center.copy(bb.min).add(bb.max).multiplyScalar(0.5);
      radius = Math.max(bb.max.distanceTo(bb.min) / 2, 1e-3);
      const dir = new Vector3(1, 0.8, 1.2).normalize();
      const dist = (radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.05;
      camera.position.copy(center).addScaledVector(dir, dist);
      camera.quaternion.copy(new Quaternion());
      camera.lookAt(center);
      camera.near = dist / 100;
      camera.far = dist * 10;
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
      this.renders++;
      return renderer.domElement.toDataURL('image/png');
    } catch {
      return null;
    } finally {
      for (const c of [...holder.children]) holder.remove(c);
      for (const g of geos) g.dispose();
    }
  }

  dispose(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.gl?.renderer.dispose();
    this.gl?.material.dispose();
    this.gl = null;
    this.cache.clear();
    this.queue.clear();
  }
}
