/**
 * Particle drawing: two instanced draw calls (normal-blended and additive), one quad per particle.
 *
 * Each pool's instance arrays (`iPos`, `iVel`, `iData`, `iColor`) are the vertex buffers: the renderer wraps them in
 * `InstancedBufferAttribute`s, uploads only the live prefix every frame and sets `instanceCount`. The vertex shader
 * builds the quad on the GPU — a camera-facing billboard, a streak along the screen-space velocity, or a quad lying
 * flat on the ground — and picks the sprite from the procedural atlas. Alpha-blended particles are drawn back to
 * front (the pool sorts them); additive ones need no order. Large soft puffs fade out in the few centimetres above
 * the floor so they do not show a hard line where they meet the ground.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  DataTexture,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  NormalBlending,
  RGBAFormat,
  ShaderMaterial,
  UnsignedByteType,
  type Object3D,
} from 'three';
import type { ParticlePool } from './particlePool';
import { ATLAS_COLS, generateAtlasLevels } from './sprites';

const VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec3 iVel;
attribute vec4 iData; // size, rotation, frame (+32 = soft floor), mode (> 0 streak per m/s, -1 flat, 0 billboard)
attribute vec4 iColor;
uniform float uCols;
varying vec2 vUv;
varying vec4 vColor;
varying float vWorldY;
varying float vSoft;
void main() {
  float size = iData.x;
  float rot = iData.y;
  float f = iData.z;
  float soft = step(31.5, f);
  float frame = f - 32.0 * soft;
  float mode = iData.w;
  vec2 c = position.xy;
  float cs = cos(rot);
  float sn = sin(rot);
  vec3 world;
  vec4 mv;
  if (mode < -0.5) {
    // Lying on the ground: rotate in the XZ plane.
    vec2 r = vec2(c.x * cs - c.y * sn, c.x * sn + c.y * cs) * size;
    world = iPos + vec3(r.x, 0.0, r.y);
    mv = viewMatrix * vec4(world, 1.0);
  } else if (mode > 0.0) {
    // A streak along the velocity as seen on screen.
    vec3 vv = mat3(viewMatrix) * iVel;
    float l2 = dot(vv.xy, vv.xy);
    vec2 dir = l2 > 1e-8 ? vv.xy * inversesqrt(l2) : vec2(1.0, 0.0);
    float len = size + sqrt(l2) * mode;
    vec2 off = dir * (c.x * len) + vec2(-dir.y, dir.x) * (c.y * size);
    mv = viewMatrix * vec4(iPos, 1.0);
    mv.xy += off;
    world = iPos + vec3(off, 0.0) * mat3(viewMatrix);
  } else {
    vec2 r = vec2(c.x * cs - c.y * sn, c.x * sn + c.y * cs) * size;
    mv = viewMatrix * vec4(iPos, 1.0);
    mv.xy += r;
    world = iPos + vec3(r, 0.0) * mat3(viewMatrix);
  }
  gl_Position = projectionMatrix * mv;
  vec2 cell = vec2(mod(frame, uCols), floor(frame / uCols));
  vUv = (cell + position.xy + 0.5) / uCols;
  vColor = iColor;
  vWorldY = world.y;
  vSoft = soft;
}`;

const FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform float uFloorY;
uniform float uSoftness;
varying vec2 vUv;
varying vec4 vColor;
varying float vWorldY;
varying float vSoft;
void main() {
  vec4 t = texture2D(uMap, vUv);
  float a = t.a * vColor.a;
  if (vSoft > 0.5) a *= smoothstep(uFloorY, uFloorY + uSoftness, vWorldY);
  if (a < 0.003) discard;
  gl_FragColor = vec4(vColor.rgb * t.rgb, a);
  #include <colorspace_fragment>
}`;

/** One pool's draw call. */
class Batch {
  readonly mesh: Mesh;
  private readonly geometry = new InstancedBufferGeometry();
  private readonly attrs: InstancedBufferAttribute[];
  private liveCount = 0;

  constructor(
    parent: Object3D,
    readonly pool: ParticlePool,
    material: ShaderMaterial,
    renderOrder: number,
    name: string,
  ) {
    const quad = new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0]), 3);
    this.geometry.setAttribute('position', quad);
    this.geometry.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 2, 1, 3]), 1));
    const mk = (attribute: string, array: Float32Array, size: number): InstancedBufferAttribute => {
      const a = new InstancedBufferAttribute(array, size).setUsage(DynamicDrawUsage);
      this.geometry.setAttribute(attribute, a);
      return a;
    };
    this.attrs = [
      mk('iPos', pool.iPos, 3),
      mk('iVel', pool.iVel, 3),
      mk('iData', pool.iData, 4),
      mk('iColor', pool.iColor, 4),
    ];
    this.geometry.instanceCount = 0;
    this.mesh = new Mesh(this.geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.visible = false;
    this.mesh.name = name;
    // A normal / depth pre-pass (ambient occlusion) renders the scene with an override material that knows nothing
    // about instances; draw no instances there.
    this.mesh.onBeforeRender = (_r, scene) => {
      this.geometry.instanceCount = scene.overrideMaterial ? 0 : this.liveCount;
    };
    parent.add(this.mesh);
  }

  /** Upload the live prefix of the instance arrays. */
  upload(): void {
    const n = this.pool.count;
    this.liveCount = n;
    this.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n === 0) return;
    for (const a of this.attrs) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * a.itemSize);
      a.needsUpdate = true;
    }
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
  }
}

export class ParticleRenderer {
  private readonly texture: DataTexture;
  private readonly normalMat: ShaderMaterial;
  private readonly additiveMat: ShaderMaterial;
  private readonly normalBatch: Batch;
  private readonly additiveBatch: Batch;

  constructor(
    parent: Object3D,
    private readonly additive: ParticlePool,
    private readonly normal: ParticlePool,
  ) {
    const levels = generateAtlasLevels();
    const tex = new DataTexture(levels[0].data, levels[0].width, levels[0].height, RGBAFormat, UnsignedByteType);
    tex.mipmaps = levels.map((l) => ({ data: l.data, width: l.width, height: l.height }));
    tex.minFilter = LinearMipmapLinearFilter;
    tex.magFilter = LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.texture = tex;

    const common = {
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: DoubleSide,
    };
    const uniforms = () => ({
      uMap: { value: tex },
      uCols: { value: ATLAS_COLS },
      uFloorY: { value: 0 },
      uSoftness: { value: 0.18 },
    });
    this.normalMat = new ShaderMaterial({ ...common, uniforms: uniforms(), blending: NormalBlending });
    this.additiveMat = new ShaderMaterial({ ...common, uniforms: uniforms(), blending: AdditiveBlending });
    this.normalBatch = new Batch(parent, normal, this.normalMat, 900, 'fx-particles-normal');
    this.additiveBatch = new Batch(parent, additive, this.additiveMat, 910, 'fx-particles-additive');
  }

  setFloor(y: number): void {
    this.normalMat.uniforms.uFloorY.value = y;
    this.additiveMat.uniforms.uFloorY.value = y;
  }

  /** Sort, evaluate the curves and upload both pools for a camera at (cx, cy, cz). */
  sync(cx: number, cy: number, cz: number): void {
    this.normal.writeInstances(this.normal.count > 1 ? this.normal.sortBackToFront(cx, cy, cz) : null);
    this.additive.writeInstances(null);
    this.normalBatch.upload();
    this.additiveBatch.upload();
  }

  get meshes(): Mesh[] {
    return [this.normalBatch.mesh, this.additiveBatch.mesh];
  }

  dispose(): void {
    this.normalBatch.dispose();
    this.additiveBatch.dispose();
    this.normalMat.dispose();
    this.additiveMat.dispose();
    this.texture.dispose();
  }
}
