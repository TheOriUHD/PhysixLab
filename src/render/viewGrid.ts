/**
 * The grid of an orthographic front / side view: the ground grid is edge-on there, so a second grid is drawn in the
 * plane the camera looks at (through the orbit target), with 1 m lines, stronger 10 m lines, and the world axes.
 */
import { DoubleSide, Mesh, PlaneGeometry, ShaderMaterial, Vector3 } from 'three';

const VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const FRAG = /* glsl */ `
varying vec3 vWorld;
uniform vec3 uU;
uniform vec3 uV;
uniform vec3 uCenter;
uniform float uFade;
uniform float uStep;
float line(vec2 p, float scale) {
  vec2 q = p / scale;
  vec2 g = abs(fract(q - 0.5) - 0.5) / max(fwidth(q), vec2(1e-5));
  return 1.0 - clamp(min(g.x, g.y), 0.0, 1.0);
}
void main() {
  vec2 p = vec2(dot(vWorld, uU), dot(vWorld, uV));
  float minor = line(p, uStep);
  float major = line(p, uStep * 10.0);
  float d = length(vWorld - uCenter);
  float fade = 1.0 - smoothstep(uFade * 0.5, uFade, d);
  float a0 = 1.0 - clamp(abs(p.y) / max(fwidth(p.y) * 1.2, 1e-5), 0.0, 1.0);
  float a1 = 1.0 - clamp(abs(p.x) / max(fwidth(p.x) * 1.2, 1e-5), 0.0, 1.0);
  vec3 col = vec3(0.62, 0.72, 0.86);
  col = mix(col, vec3(0.95, 0.35, 0.35), a0);
  col = mix(col, vec3(0.35, 0.9, 0.55), a1);
  float a = minor * 0.10 + major * 0.22;
  a = max(a, max(a0, a1) * 0.5);
  a *= fade;
  if (a < 0.002) discard;
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}`;

export type ViewPlane = 'xy' | 'zy' | null;

export class ViewGrid {
  readonly mesh: Mesh;
  private mat: ShaderMaterial;

  constructor() {
    this.mat = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      uniforms: {
        uU: { value: new Vector3(1, 0, 0) },
        uV: { value: new Vector3(0, 1, 0) },
        uCenter: { value: new Vector3() },
        uFade: { value: 120 },
        uStep: { value: 1 },
      },
    });
    this.mesh = new Mesh(new PlaneGeometry(2000, 2000), this.mat);
    this.mesh.renderOrder = 0;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
  }

  /** `xy`: looking along z (front / back), `zy`: looking along x (right / left); null hides it. */
  set(plane: ViewPlane, center: Vector3, fade: number, step: number): void {
    this.mesh.visible = plane !== null;
    if (!plane) return;
    const u = this.mat.uniforms.uU.value as Vector3;
    const v = this.mat.uniforms.uV.value as Vector3;
    if (plane === 'xy') {
      u.set(1, 0, 0);
      v.set(0, 1, 0);
      this.mesh.rotation.set(0, 0, 0);
    } else {
      u.set(0, 0, 1);
      v.set(0, 1, 0);
      this.mesh.rotation.set(0, Math.PI / 2, 0);
    }
    this.mesh.position.copy(center);
    (this.mat.uniforms.uCenter.value as Vector3).copy(center);
    this.mat.uniforms.uFade.value = fade;
    this.mat.uniforms.uStep.value = step;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
