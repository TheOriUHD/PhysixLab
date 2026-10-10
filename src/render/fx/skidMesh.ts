/**
 * Skid marks, the drawing side: one mesh over the `SkidBuffer`'s arrays.
 *
 * The geometry is allocated once for the buffer's capacity (positions, per-vertex marks, a fixed index pattern of two
 * triangles per segment). Each frame only the slots written since the last frame are re-uploaded, and the draw range
 * covers the live segments. A mark fades by age in the shader (`uTime − birth`), so ageing costs nothing on the CPU.
 * The marks are unlit and tinted from the ground colour so they read as darker (or paler) ground, not as black paint.
 */
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Mesh,
  ShaderMaterial,
  Vector3,
  type Object3D,
} from 'three';
import type { SkidBuffer } from './skidBuffer';

const VERT = /* glsl */ `
attribute vec4 aMark; // birth time, side, opacity, tone
varying vec4 vMark;
varying vec3 vWorld;
void main() {
  vMark = aMark;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const FRAG = /* glsl */ `
uniform float uTime;
uniform float uFadeStart;
uniform float uFadeEnd;
uniform vec3 uGround;
varying vec4 vMark;
varying vec3 vWorld;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  float age = uTime - vMark.x;
  float fade = 1.0 - smoothstep(uFadeStart, uFadeEnd, age);
  float side = 1.0 - smoothstep(0.5, 1.0, abs(vMark.y));
  float grain = 0.7 + 0.3 * vnoise(vWorld.xz * 34.0) + 0.1 * vnoise(vWorld.xz * 9.0);
  float a = vMark.z * fade * side * grain;
  if (a < 0.004) discard;
  vec3 dark = uGround * 0.08;
  vec3 pale = uGround * 2.4 + 0.03;
  gl_FragColor = vec4(mix(dark, pale, vMark.w), a);
  #include <colorspace_fragment>
}`;

/** Seconds a mark stays at full strength / when it has gone, on the effects clock. */
export const SKID_FADE_START = 40;
export const SKID_FADE_END = 70;

export class SkidMarkMesh {
  readonly mesh: Mesh;
  private readonly geometry = new BufferGeometry();
  private readonly posAttr: BufferAttribute;
  private readonly markAttr: BufferAttribute;
  private readonly material: ShaderMaterial;
  private liveIndices = 0;

  constructor(
    parent: Object3D,
    private readonly buffer: SkidBuffer,
  ) {
    const cap = buffer.capacity;
    this.posAttr = new BufferAttribute(buffer.pos, 3).setUsage(DynamicDrawUsage);
    this.markAttr = new BufferAttribute(buffer.mark, 4).setUsage(DynamicDrawUsage);
    const index = new Uint32Array(cap * 6);
    for (let i = 0; i < cap; i++) index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setAttribute('aMark', this.markAttr);
    this.geometry.setIndex(new BufferAttribute(index, 1));
    this.geometry.setDrawRange(0, 0);
    this.material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uFadeStart: { value: SKID_FADE_START },
        uFadeEnd: { value: SKID_FADE_END },
        uGround: { value: new Vector3(0.03, 0.03, 0.04) },
      },
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.visible = false;
    this.mesh.name = 'fx-skid-marks';
    // An ambient-occlusion / normal pre-pass renders the whole scene with an override material; skip the marks there.
    this.mesh.onBeforeRender = (_r, scene) => {
      this.geometry.setDrawRange(0, scene.overrideMaterial ? 0 : this.liveIndices);
    };
    parent.add(this.mesh);
  }

  setGroundColor(r: number, g: number, b: number): void {
    (this.material.uniforms.uGround.value as Vector3).set(r, g, b);
  }

  /** Upload what changed and set the clock. */
  sync(time: number): void {
    this.material.uniforms.uTime.value = time;
    const d = this.buffer.takeDirty();
    if (d) {
      const [lo, hi] = d;
      this.posAttr.clearUpdateRanges();
      this.markAttr.clearUpdateRanges();
      this.posAttr.addUpdateRange(lo * 12, (hi - lo + 1) * 12);
      this.markAttr.addUpdateRange(lo * 16, (hi - lo + 1) * 16);
      this.posAttr.needsUpdate = true;
      this.markAttr.needsUpdate = true;
    }
    this.liveIndices = this.buffer.count * 6;
    this.mesh.visible = this.liveIndices > 0;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
