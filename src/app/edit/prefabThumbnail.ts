/**
 * ED-22 — thumbnails of prefabs.
 *
 * Preferred: a small offscreen three.js render of the real shape geometry (the same `ShapeDef.geometry` factories
 * the viewport uses) from a three-quarter view, as a PNG data URL. Without WebGL (or when the context cannot be
 * created) the top-down SVG sketch of `mapKit.topDownThumbnail` is used instead. All GPU objects are disposed
 * before returning, and the result is capped to `PREFAB_LIMITS.maxThumbnailChars`.
 */
import {
  AmbientLight,
  Box3,
  BoxGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Quaternion,
  Scene,
  Sphere,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
  type BufferGeometry,
} from 'three';
import { PREFAB_LIMITS } from '../../model/edit/userPrefab';
import { newDocument } from '../../model/factory';
import { topDownThumbnail } from '../../model/mapKit';
import { shapeGeometry, shapeVisualScale } from '../../model/shapeRegistry';
import type { Entity, ShapeSpec } from '../../model/types';
import { isBody, isSoft } from '../../model/types';
import { GEOMETRY_KIT } from '../../render/geometryKit';

export const THUMBNAIL_PX = 128;

/** Top-down SVG sketch of the entities (no WebGL needed). */
export function svgThumbnail(entities: readonly Entity[], px = THUMBNAIL_PX): string {
  const doc = newDocument('prefab');
  doc.settings.ground.enabled = false;
  doc.entities = [...entities];
  return topDownThumbnail(doc, px);
}

interface Piece {
  geometry: BufferGeometry;
  scale: [number, number, number];
  position: [number, number, number];
  quaternion: [number, number, number, number];
  color: string;
  opacity: number;
}

function piecesOf(entities: readonly Entity[]): Piece[] {
  const out: Piece[] = [];
  const spec = (
    s: ShapeSpec,
    p: [number, number, number],
    q: [number, number, number, number],
    color: string,
    opacity: number,
  ) =>
    out.push({
      geometry: shapeGeometry(GEOMETRY_KIT, s),
      scale: shapeVisualScale(s),
      position: p,
      quaternion: q,
      color,
      opacity,
    });
  for (const e of entities) {
    if (isBody(e)) {
      if (e.hidden) continue;
      const base = e.material;
      if (e.parts?.length) {
        for (const part of e.parts) {
          if (part.visible === false) continue;
          // Part poses are in the body frame: compose with the body pose.
          const bq = new Quaternion(...e.rotation);
          const pq = new Vector3(...part.position).applyQuaternion(bq);
          const q = bq.clone().multiply(new Quaternion(...part.rotation));
          spec(
            part.shape,
            [e.position[0] + pq.x, e.position[1] + pq.y, e.position[2] + pq.z],
            [q.x, q.y, q.z, q.w],
            part.material?.color ?? base.color,
            base.opacity,
          );
        }
      } else spec(e.shape, e.position, e.rotation, base.color, base.opacity);
    } else if (isSoft(e) && !e.hidden) {
      // Soft bodies are drawn as the volume they start in: a block, or a ball for balloons.
      const g = e.type === 'balloon' ? new SphereGeometry(0.5, 16, 12) : new BoxGeometry(1, 1, 1);
      const s: [number, number, number] =
        e.type === 'balloon' ? [e.size[0], e.size[0], e.size[0]] : [e.size[0], Math.max(e.size[1], 0.05), e.size[2]];
      out.push({
        geometry: g,
        scale: s,
        position: e.position,
        quaternion: e.rotation,
        color: e.color,
        opacity: e.opacity,
      });
    }
  }
  return out;
}

/**
 * Render the entities to a PNG data URL with WebGL. Returns null when WebGL is unavailable or nothing is drawable.
 * Needs a DOM (`document.createElement('canvas')`).
 */
export function renderThumbnail(entities: readonly Entity[], px = THUMBNAIL_PX): string | null {
  if (typeof document === 'undefined') return null;
  const pieces = piecesOf(entities);
  if (!pieces.length) return null;

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = px;
  let renderer: WebGLRenderer | null = null;
  const scene = new Scene();
  const materials: MeshStandardMaterial[] = [];
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(px, px, false);
    renderer.setClearColor(new Color('#10151d'), 1);

    for (const p of pieces) {
      const m = new MeshStandardMaterial({
        color: p.color,
        roughness: 0.55,
        metalness: 0.1,
        transparent: p.opacity < 1,
        opacity: p.opacity,
      });
      materials.push(m);
      const mesh = new Mesh(p.geometry, m);
      mesh.scale.set(...p.scale);
      mesh.position.set(...p.position);
      mesh.quaternion.set(...p.quaternion);
      scene.add(mesh);
    }
    scene.add(new HemisphereLight('#dbe8ff', '#3a3f48', 1.1), new AmbientLight('#ffffff', 0.35));
    const sun = new DirectionalLight('#ffffff', 2.2);
    sun.position.set(4, 8, 5);
    scene.add(sun);

    // Frame the bounding sphere from a three-quarter view.
    scene.updateMatrixWorld(true);
    const box = new Box3().setFromObject(scene);
    const sphere = box.getBoundingSphere(new Sphere());
    const camera = new PerspectiveCamera(32, 1, 0.05, 10_000);
    const dist = (Math.max(sphere.radius, 0.1) / Math.sin((camera.fov * Math.PI) / 360)) * 1.08;
    const dir = new Vector3(1, 0.75, 1.15).normalize();
    camera.position.copy(sphere.center).addScaledVector(dir, dist);
    camera.lookAt(sphere.center);
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
    const url = canvas.toDataURL('image/png');
    return url.length <= PREFAB_LIMITS.maxThumbnailChars ? url : null;
  } catch {
    return null;
  } finally {
    for (const p of pieces) p.geometry.dispose();
    for (const m of materials) m.dispose();
    scene.clear();
    if (renderer) {
      renderer.dispose();
      renderer.forceContextLoss();
    }
  }
}

/** The best thumbnail available: WebGL render, else the SVG sketch, else '' (size cap). */
export function makeThumbnail(entities: readonly Entity[], px = THUMBNAIL_PX): string {
  const gl = renderThumbnail(entities, px);
  if (gl) return gl;
  try {
    const svg = svgThumbnail(entities, px);
    return svg.length <= PREFAB_LIMITS.maxThumbnailChars ? svg : '';
  } catch {
    return '';
  }
}
