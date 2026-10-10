/**
 * Live material preview (VZ-4): a lit sphere rendered by one small shared offscreen renderer and copied into the
 * caller's 2D canvas. Uses the same material builder as the viewport, so what you see is what the body gets.
 */
import {
  DirectionalLight,
  IcosahedronGeometry,
  Mesh,
  MeshPhysicalMaterial,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { MaterialSpec } from '../model/types';
import { buildEnvScene, disposeEnvScene, ENV_PRESET_BY_ID } from './envPresets';
import { applyMaterialSpec, disposeMaterialTextures } from './materialBuild';

const SIZE = 192;

let shared: { renderer: WebGLRenderer; scene: Scene; camera: PerspectiveCamera } | null | undefined;

function getShared() {
  if (shared !== undefined) return shared;
  try {
    const renderer = new WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(SIZE, SIZE, false);
    renderer.setPixelRatio(1);
    renderer.setClearColor(0x000000, 0);
    const scene = new Scene();
    const preset = ENV_PRESET_BY_ID.get('studio');
    if (preset) {
      const pmrem = new PMREMGenerator(renderer);
      const envScene = buildEnvScene(preset, new Vector3(0, 1, 0));
      scene.environment = pmrem.fromScene(envScene, 0.03).texture;
      disposeEnvScene(envScene);
      pmrem.dispose();
    }
    const key = new DirectionalLight(0xffffff, 1.6);
    key.position.set(-2, 3, 4);
    scene.add(key);
    const camera = new PerspectiveCamera(30, 1, 0.1, 20);
    camera.position.set(0, 0, 3.4);
    shared = { renderer, scene, camera };
  } catch {
    shared = null; // no WebGL available: callers hide the preview
  }
  return shared;
}

export class MaterialPreview {
  readonly canvas = document.createElement('canvas');
  private readonly material = new MeshPhysicalMaterial();
  private readonly mesh: Mesh;
  private readonly ctx: CanvasRenderingContext2D | null;
  readonly available: boolean;

  constructor() {
    this.canvas.width = this.canvas.height = SIZE;
    this.canvas.className = 'material-preview';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Material preview');
    this.ctx = this.canvas.getContext('2d');
    this.mesh = new Mesh(new IcosahedronGeometry(1, 5), this.material);
    this.available = getShared() !== null;
  }

  /** Render `spec` on the sphere. */
  update(spec: MaterialSpec): void {
    const s = getShared();
    if (!s || !this.ctx) return;
    applyMaterialSpec(this.material, spec);
    // the sphere has a proper UV set only for pattern textures; keep it simple: spherical UVs from the normal
    const geo = this.mesh.geometry;
    if (!geo.getAttribute('uv')) addSphereUv(geo);
    s.scene.add(this.mesh);
    s.renderer.render(s.scene, s.camera);
    s.scene.remove(this.mesh);
    this.ctx.clearRect(0, 0, SIZE, SIZE);
    this.ctx.drawImage(s.renderer.domElement, 0, 0);
  }

  dispose(): void {
    disposeMaterialTextures(this.material);
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}

function addSphereUv(geo: Mesh['geometry']): void {
  const pos = geo.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    uv[i * 2] = 0.5 + Math.atan2(z, x) / (2 * Math.PI);
    uv[i * 2 + 1] = 0.5 + Math.asin(Math.max(-1, Math.min(1, y))) / Math.PI;
  }
  geo.setAttribute('uv', new (pos.constructor as { new (a: Float32Array, n: number): typeof pos })(uv, 2));
}
