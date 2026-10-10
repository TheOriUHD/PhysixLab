/**
 * VZ-20 / VZ-21: the custom post-processing passes (everything the stock three.js passes do not cover): scene depth
 * capture, depth of field, light shafts, velocity-buffer motion blur and the "finish" pass (chromatic aberration,
 * colour grading, vignette, film grain). All of them work in linear HDR before the output (tone mapping) pass.
 */
import {
  Color,
  HalfFloatType,
  Matrix4,
  NearestFilter,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type Camera,
  type DepthTexture,
  type Object3D,
  type PerspectiveCamera,
  type Scene,
  type WebGLRenderer,
} from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

/** Shared depth access (perspective depth texture → view-space distance). */
const DEPTH_GLSL = /* glsl */ `
uniform sampler2D tDepth;
uniform float uNear;
uniform float uFar;
float viewZ(float d) { return (uNear * uFar) / (uFar - d * (uFar - uNear)); }
`;

abstract class QuadPass extends Pass {
  protected quad: FullScreenQuad;
  protected material: ShaderMaterial;
  constructor(material: ShaderMaterial) {
    super();
    this.material = material;
    this.quad = new FullScreenQuad(material);
  }
  dispose(): void {
    this.material.dispose();
    this.quad.dispose();
  }
  protected draw(
    renderer: WebGLRenderer,
    writeBuffer: WebGLRenderTarget,
    readBuffer: WebGLRenderTarget,
    uniform = 'tDiffuse',
  ): void {
    this.material.uniforms[uniform].value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.quad.render(renderer);
  }
}

// ---- depth capture --------------------------------------------------------------------------------------------

/** Placed right after the scene render: remembers which render target (and so which depth texture) holds the scene. */
export class DepthCapturePass extends Pass {
  depth: DepthTexture | null = null;
  constructor() {
    super();
    this.needsSwap = false;
  }
  render(renderer: WebGLRenderer, _w: WebGLRenderTarget, readBuffer: WebGLRenderTarget): void {
    this.depth = readBuffer.depthTexture;
    // The shadow maps of this frame exist now: the passes after this one re-render the scene (normals, velocity,
    // outline …) and must not render the shadows again. `PostStack.render` restores the flag.
    renderer.shadowMap.autoUpdate = false;
  }
}

// ---- finish: aberration, grading, vignette, grain ---------------------------------------------------------------

export interface FinishSettings {
  aberration: number;
  exposure: number;
  contrast: number;
  saturation: number;
  temperature: number;
  vignette: number;
  vignetteSoftness: number;
  grain: number;
}

export class FinishPass extends QuadPass {
  constructor() {
    super(
      new ShaderMaterial({
        uniforms: {
          tDiffuse: { value: null },
          uAberration: { value: 0 },
          uExposure: { value: 1 },
          uContrast: { value: 1 },
          uSaturation: { value: 1 },
          uTemperature: { value: 0 },
          uVignette: { value: 0 },
          uVignetteSoft: { value: 0.5 },
          uGrain: { value: 0 },
          uTime: { value: 0 },
        },
        vertexShader: VERT,
        fragmentShader: /* glsl */ `
          uniform sampler2D tDiffuse;
          uniform float uAberration, uExposure, uContrast, uSaturation, uTemperature, uVignette, uVignetteSoft, uGrain, uTime;
          varying vec2 vUv;
          float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
          void main() {
            vec2 c = vUv - 0.5;
            float r2 = dot(c, c);
            vec3 col;
            if (uAberration > 0.0) {
              vec2 off = c * r2 * uAberration * 6.0;
              col = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
            } else {
              col = texture2D(tDiffuse, vUv).rgb;
            }
            col *= uExposure;
            col *= vec3(1.0 + 0.18 * uTemperature, 1.0 + 0.02 * uTemperature, 1.0 - 0.18 * uTemperature);
            // contrast pivots on mid grey (linear 0.18)
            col = pow(max(col, vec3(0.0)) / 0.18, vec3(uContrast)) * 0.18;
            float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
            col = mix(vec3(l), col, uSaturation);
            float v = smoothstep(0.75, 0.75 - uVignetteSoft * 0.75, sqrt(r2) * 1.414);
            col *= mix(1.0, v, uVignette);
            if (uGrain > 0.0) {
              float n = hash(vUv * 1024.0 + fract(uTime) * 91.7) - 0.5;
              col += n * uGrain * (0.25 + l * 0.75 + 0.05);
            }
            gl_FragColor = vec4(col, 1.0);
          }`,
        depthTest: false,
        depthWrite: false,
      }),
    );
  }

  set(s: FinishSettings): void {
    const u = this.material.uniforms;
    u.uAberration.value = s.aberration;
    u.uExposure.value = Math.pow(2, s.exposure);
    u.uContrast.value = s.contrast;
    u.uSaturation.value = s.saturation;
    u.uTemperature.value = s.temperature;
    u.uVignette.value = s.vignette;
    u.uVignetteSoft.value = s.vignetteSoftness;
    u.uGrain.value = s.grain;
  }

  render(renderer: WebGLRenderer, writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget, dt: number): void {
    this.material.uniforms.uTime.value = (this.material.uniforms.uTime.value as number) + dt;
    this.draw(renderer, writeBuffer, readBuffer);
  }
}

// ---- depth of field ---------------------------------------------------------------------------------------------

export class DofPass extends QuadPass {
  constructor(
    private camera: PerspectiveCamera,
    private depthSource: DepthCapturePass,
  ) {
    super(
      new ShaderMaterial({
        uniforms: {
          tDiffuse: { value: null },
          tDepth: { value: null },
          uNear: { value: 0.05 },
          uFar: { value: 2000 },
          uFocus: { value: 10 },
          uAperture: { value: 0.35 },
          uMaxBlur: { value: 12 },
          uTexel: { value: new Vector2(1, 1) },
        },
        vertexShader: VERT,
        fragmentShader: /* glsl */ `
          uniform sampler2D tDiffuse;
          uniform float uFocus, uAperture, uMaxBlur;
          uniform vec2 uTexel;
          varying vec2 vUv;
          ${DEPTH_GLSL}
          float coc(vec2 uv) {
            float z = viewZ(texture2D(tDepth, uv).x);
            return clamp(uAperture * 2.0 * abs(z - uFocus) / max(z, 0.5), 0.0, 1.0) * uMaxBlur;
          }
          void main() {
            float c0 = coc(vUv);
            vec4 base = texture2D(tDiffuse, vUv);
            if (c0 < 0.6) { gl_FragColor = base; return; }
            vec3 acc = base.rgb; float wsum = 1.0;
            const int N = 28;
            for (int i = 0; i < N; i++) {
              float fi = float(i) + 0.5;
              float r = sqrt(fi / float(N));
              float a = fi * 2.39996323;
              vec2 o = vec2(cos(a), sin(a)) * r * c0;
              vec2 uv = vUv + o * uTexel;
              float cs = coc(uv);
              // a sharper sample must not bleed over a blurrier pixel: weight by how far its own blur reaches
              float w = clamp(cs / max(r * c0, 0.5), 0.0, 1.0);
              acc += texture2D(tDiffuse, uv).rgb * w;
              wsum += w;
            }
            gl_FragColor = vec4(acc / wsum, base.a);
          }`,
        depthTest: false,
        depthWrite: false,
      }),
    );
  }

  /** `focus` in metres. */
  set(focus: number, aperture: number, maxBlur: number): void {
    const u = this.material.uniforms;
    u.uFocus.value = focus;
    u.uAperture.value = aperture;
    u.uMaxBlur.value = maxBlur;
  }

  setSize(w: number, h: number): void {
    (this.material.uniforms.uTexel.value as Vector2).set(1 / w, 1 / h);
  }

  render(renderer: WebGLRenderer, writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget): void {
    const u = this.material.uniforms;
    u.tDepth.value = this.depthSource.depth;
    u.uNear.value = this.camera.near;
    u.uFar.value = this.camera.far;
    this.draw(renderer, writeBuffer, readBuffer);
  }
}

// ---- light shafts (god rays) ---------------------------------------------------------------------------------------

export interface ShaftSource {
  /** Normalised screen position (0..1). */
  uv: Vector2;
  /** View-space distance of the source; Infinity for the sun (rays only pass where the sky is visible). */
  distance: number;
  color: Color;
  intensity: number;
}

export const MAX_SHAFT_SOURCES = 3;

export class GodRaysPass extends QuadPass {
  readonly sources: ShaftSource[] = [];
  decay = 0.95;
  constructor(
    private camera: PerspectiveCamera,
    private depthSource: DepthCapturePass,
  ) {
    const uv: Vector2[] = [];
    const col: Vector3[] = [];
    for (let i = 0; i < MAX_SHAFT_SOURCES; i++) {
      uv.push(new Vector2(0.5, 0.5));
      col.push(new Vector3());
    }
    super(
      new ShaderMaterial({
        uniforms: {
          tDiffuse: { value: null },
          tDepth: { value: null },
          uNear: { value: 0.05 },
          uFar: { value: 2000 },
          uCount: { value: 0 },
          uUv: { value: uv },
          uDist: { value: new Float32Array(MAX_SHAFT_SOURCES) },
          uColor: { value: col },
          uDecay: { value: 0.95 },
        },
        vertexShader: VERT,
        fragmentShader: /* glsl */ `
          uniform sampler2D tDiffuse;
          uniform int uCount;
          uniform vec2 uUv[${MAX_SHAFT_SOURCES}];
          uniform float uDist[${MAX_SHAFT_SOURCES}];
          uniform vec3 uColor[${MAX_SHAFT_SOURCES}];
          uniform float uDecay;
          varying vec2 vUv;
          ${DEPTH_GLSL}
          void main() {
            vec3 base = texture2D(tDiffuse, vUv).rgb;
            vec3 add = vec3(0.0);
            const int STEPS = 40;
            for (int s = 0; s < ${MAX_SHAFT_SOURCES}; s++) {
              if (s >= uCount) break;
              vec2 delta = (uUv[s] - vUv) / float(STEPS);
              float falloff = 1.0 / (1.0 + 14.0 * dot(uUv[s] - vUv, uUv[s] - vUv));
              vec2 p = vUv;
              float w = 1.0; float acc = 0.0;
              for (int i = 0; i < STEPS; i++) {
                p += delta;
                if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) break;
                float d = texture2D(tDepth, p).x;
                float open = uDist[s] > 1e5 ? step(0.99999, d) : step(uDist[s], viewZ(d));
                acc += open * w;
                w *= uDecay;
              }
              add += uColor[s] * (acc / float(STEPS)) * falloff;
            }
            gl_FragColor = vec4(base + add, 1.0);
          }`,
        depthTest: false,
        depthWrite: false,
      }),
    );
  }

  render(renderer: WebGLRenderer, writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget): void {
    const u = this.material.uniforms;
    u.tDepth.value = this.depthSource.depth;
    u.uNear.value = this.camera.near;
    u.uFar.value = this.camera.far;
    u.uDecay.value = this.decay;
    const n = Math.min(MAX_SHAFT_SOURCES, this.sources.length);
    u.uCount.value = n;
    for (let i = 0; i < n; i++) {
      const s = this.sources[i];
      (u.uUv.value as Vector2[])[i].copy(s.uv);
      (u.uDist.value as Float32Array)[i] = s.distance;
      (u.uColor.value as Vector3[])[i].set(s.color.r, s.color.g, s.color.b).multiplyScalar(s.intensity);
    }
    this.draw(renderer, writeBuffer, readBuffer);
  }
}

// ---- motion blur (velocity buffer: camera + object motion) -----------------------------------------------------------

const ZERO_VEL = new Vector3();

const VELOCITY_VERT = /* glsl */ `
uniform mat4 uPrevViewProj;
uniform vec3 uObjVel;
uniform float uShutter;
attribute vec3 aVel;
varying vec4 vCur;
varying vec4 vPrev;
void main() {
  vec4 p = vec4(position, 1.0);
  #ifdef USE_INSTANCING
    p = instanceMatrix * p;
  #endif
  vec4 wp = modelMatrix * p;
  vec3 v = uObjVel;
  #ifdef USE_INSTANCING
    v += aVel;
  #endif
  vec4 prevWp = vec4(wp.xyz - v * uShutter, 1.0);
  vCur = projectionMatrix * viewMatrix * wp;
  vPrev = uPrevViewProj * prevWp;
  gl_Position = vCur;
}`;

const VELOCITY_FRAG = /* glsl */ `
varying vec4 vCur;
varying vec4 vPrev;
void main() {
  vec2 a = vCur.xy / vCur.w;
  vec2 b = vPrev.xy / max(vPrev.w, 1e-4);
  gl_FragColor = vec4((a - b) * 0.5, 0.0, 1.0); // in UV units
}`;

export class MotionBlurPass extends QuadPass {
  strength = 0.6;
  /** Objects that must not appear in the velocity buffer (helpers, overlays, joints, sky …). */
  hidden: Object3D[] = [];
  private velocity: WebGLRenderTarget;
  private velMaterial: ShaderMaterial;
  private prevViewProj = new Matrix4();
  private tmp = new Matrix4();
  private havePrev = false;
  private shutter = 1 / 60;

  constructor(
    private scene: Scene,
    private camera: Camera,
  ) {
    super(
      new ShaderMaterial({
        uniforms: {
          tDiffuse: { value: null },
          tVelocity: { value: null },
          uScale: { value: 1 },
          uMaxPx: { value: 48 },
          uTexel: { value: new Vector2(1, 1) },
        },
        vertexShader: VERT,
        fragmentShader: /* glsl */ `
          uniform sampler2D tDiffuse, tVelocity;
          uniform float uScale, uMaxPx;
          uniform vec2 uTexel;
          varying vec2 vUv;
          void main() {
            vec2 v = texture2D(tVelocity, vUv).xy * uScale;
            float px = length(v / uTexel);
            if (px < 0.75) { gl_FragColor = texture2D(tDiffuse, vUv); return; }
            if (px > uMaxPx) v *= uMaxPx / px;
            vec3 acc = vec3(0.0);
            const int N = 14;
            for (int i = 0; i < N; i++) {
              float t = (float(i) + 0.5) / float(N) - 0.5;
              acc += texture2D(tDiffuse, vUv + v * t).rgb;
            }
            gl_FragColor = vec4(acc / float(N), 1.0);
          }`,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.velocity = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
    });
    this.velMaterial = new ShaderMaterial({
      uniforms: {
        uPrevViewProj: { value: this.prevViewProj },
        uObjVel: { value: new Vector3() },
        uShutter: { value: this.shutter },
      },
      vertexShader: VELOCITY_VERT,
      fragmentShader: VELOCITY_FRAG,
    });
    // Per-draw: every mesh brings its own velocity (`userData.vel`, a shared Vector3), instances bring `aVel`.
    this.velMaterial.onBeforeRender = (_r, _s, _c, _g, object) => {
      const v = (object.userData.vel as Vector3 | undefined) ?? ZERO_VEL;
      (this.velMaterial.uniforms.uObjVel.value as Vector3).copy(v);
      this.velMaterial.uniformsNeedUpdate = true;
    };
  }

  setSize(w: number, h: number): void {
    // Half resolution: velocity is smooth, and the extra scene render is the cost of this effect.
    this.velocity.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    (this.material.uniforms.uTexel.value as Vector2).set(1 / w, 1 / h);
  }

  render(renderer: WebGLRenderer, writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget, dt: number): void {
    const cam = this.camera;
    this.tmp.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    if (!this.havePrev) {
      this.prevViewProj.copy(this.tmp);
      this.havePrev = true;
    }
    // Objects blur by velocity × the real frame time (clamped); the user's strength scales the combined velocity.
    this.shutter = Math.min(0.05, Math.max(1 / 240, dt));
    this.velMaterial.uniforms.uShutter.value = this.shutter;

    const prevVis = this.hidden.map((o) => o.visible);
    for (const o of this.hidden) o.visible = false;
    const prevOverride = this.scene.overrideMaterial;
    const shadowAuto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false; // shadows of this frame are already rendered
    const prevBg = this.scene.background;
    const prevFog = this.scene.fog;
    this.scene.overrideMaterial = this.velMaterial;
    this.scene.background = null;
    this.scene.fog = null;
    const prevColor = renderer.getClearColor(new Color());
    const prevAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(this.velocity);
    renderer.clear();
    renderer.render(this.scene, cam);
    renderer.setClearColor(prevColor, prevAlpha);
    renderer.shadowMap.autoUpdate = shadowAuto;
    this.scene.overrideMaterial = prevOverride;
    this.scene.background = prevBg;
    this.scene.fog = prevFog;
    this.hidden.forEach((o, i) => (o.visible = prevVis[i]));

    this.prevViewProj.copy(this.tmp);
    const u = this.material.uniforms;
    u.tVelocity.value = this.velocity.texture;
    u.uScale.value = this.strength;
    this.draw(renderer, writeBuffer, readBuffer);
  }

  dispose(): void {
    this.velocity.dispose();
    this.velMaterial.dispose();
    super.dispose();
  }
}
