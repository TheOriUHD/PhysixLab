/**
 * VZ-20 / VZ-21: the post-processing stack. Owns the EffectComposer and builds its pass list from the resolved
 * graphics settings:
 *
 *   scene → [GTAO] → [SSR] → [light shafts] → [depth of field] → [motion blur] → [bloom] → outline →
 *   [finish: aberration · grading · vignette · grain] → tone mapping / output → [FXAA | SMAA]
 *
 * Everything before the output pass works on linear HDR colour. A change of *which* passes exist rebuilds the
 * composer (`passSignature`); a change of a slider only retunes uniforms. Expensive passes are created lazily and
 * kept for the next rebuild.
 */
import {
  Color,
  DepthTexture,
  HalfFloatType,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type DirectionalLight,
  type Mesh,
  type Object3D,
  type PerspectiveCamera,
  type Scene,
  type SpotLight,
  type WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import type { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { SSRPass } from 'three/addons/postprocessing/SSRPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { passSignature, type ResolvedGraphics } from './graphics';
import { DepthCapturePass, DofPass, FinishPass, GodRaysPass, MotionBlurPass, type ShaftSource } from './postPasses';

export class PostStack {
  private composer: EffectComposer;
  private renderPass: RenderPass;
  private capture = new DepthCapturePass();
  private output = new OutputPass();
  private ao: GTAOPass | null = null;
  private ssr: SSRPass | null = null;
  private bloom: UnrealBloomPass | null = null;
  private dof: DofPass | null = null;
  private rays: GodRaysPass | null = null;
  private motion: MotionBlurPass | null = null;
  private finish: FinishPass | null = null;
  private fxaa: FXAAPass | null = null;
  private smaa: SMAAPass | null = null;
  private signature = '';
  private resolved: ResolvedGraphics | null = null;
  private width = 1;
  private height = 1;
  private pixelRatio = 1;
  /** Distance (m) the DOF focuses on when the focus mode is "target" (the viewport sets it every frame). */
  focusDistance = 10;
  /** Directional light the shafts come from. */
  sun: DirectionalLight | null = null;
  /** Meshes that reflect in SSR (supplied by the body views; refreshed by the viewport). */
  reflectives: Mesh[] = [];
  /** Objects hidden from the velocity pass (overlays, helpers, joints, sky …). */
  velocityHidden: Object3D[] = [];
  private spots: SpotLight[] = [];
  private spotScan = 0;
  private sources: ShaftSource[] = [];
  private readonly tmpV = new Vector3();

  constructor(
    private renderer: WebGLRenderer,
    private scene: Scene,
    private camera: PerspectiveCamera,
    private outline: OutlinePass,
  ) {
    this.renderPass = new RenderPass(scene, camera);
    this.composer = new EffectComposer(renderer, this.makeTarget(0, false));
    for (let i = 0; i < 4; i++) this.sources.push({ uv: new Vector2(), distance: 0, color: new Color(), intensity: 0 });
  }

  get currentSignature(): string {
    return this.signature;
  }

  /** The tier-resolved settings the stack is currently built for. */
  get config(): ResolvedGraphics | null {
    return this.resolved;
  }

  private makeTarget(samples: number, depth: boolean): WebGLRenderTarget {
    const rt = new WebGLRenderTarget(this.width * this.pixelRatio || 1, this.height * this.pixelRatio || 1, {
      type: HalfFloatType,
      samples,
    });
    if (depth) rt.depthTexture = new DepthTexture(1, 1);
    return rt;
  }

  /** Apply settings: rebuilds the pass list when its structure changed, always retunes the parameters. */
  configure(g: ResolvedGraphics): void {
    const sig = passSignature(g);
    this.resolved = g;
    if (sig !== this.signature) this.rebuild(g, sig);
    this.tune(g);
  }

  private rebuild(g: ResolvedGraphics, sig: string): void {
    this.signature = sig;
    const needsDepth = !!(g.dof || g.godRays);
    this.composer.passes.length = 0; // the passes outlive the composer
    this.composer.dispose();
    const samples = g.aa === 'msaa' ? g.msaaSamples : 0;
    this.composer = new EffectComposer(this.renderer, this.makeTarget(samples, needsDepth));
    this.composer.setPixelRatio(this.pixelRatio);
    const c = this.composer;
    c.addPass(this.renderPass);
    c.addPass(this.capture);
    if (g.ao) {
      this.ao ??= new GTAOPass(this.scene, this.camera, this.width, this.height);
      this.ao.output = GTAOPass.OUTPUT.Default;
      this.ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 5, rings: 2, samples: 12 });
      c.addPass(this.ao);
    }
    if (g.ssr) {
      this.ssr ??= new SSRPass({
        renderer: this.renderer,
        scene: this.scene,
        camera: this.camera,
        width: this.width,
        height: this.height,
        selects: [],
        groundReflector: null,
      });
      this.ssr.thickness = 0.03;
      this.ssr.resolutionScale = 0.5;
      c.addPass(this.ssr);
    }
    if (g.godRays) {
      this.rays ??= new GodRaysPass(this.camera, this.capture);
      c.addPass(this.rays);
    }
    if (g.dof) {
      this.dof ??= new DofPass(this.camera, this.capture);
      c.addPass(this.dof);
    }
    if (g.motionBlur) {
      this.motion ??= new MotionBlurPass(this.scene, this.camera);
      c.addPass(this.motion);
    }
    if (g.bloom) {
      this.bloom ??= new UnrealBloomPass(new Vector2(this.width, this.height), 0.35, 0.5, 1);
      c.addPass(this.bloom);
    }
    c.addPass(this.outline);
    if (g.vignette || g.aberration || g.grain || g.grading) {
      this.finish ??= new FinishPass();
      c.addPass(this.finish);
    }
    c.addPass(this.output);
    if (g.aa === 'fxaa') {
      this.fxaa ??= new FXAAPass();
      c.addPass(this.fxaa);
    } else if (g.aa === 'smaa') {
      this.smaa ??= new SMAAPass();
      c.addPass(this.smaa);
    }
    c.setSize(this.width, this.height);
  }

  private tune(g: ResolvedGraphics): void {
    if (g.ao && this.ao) {
      this.ao.blendIntensity = g.ao.intensity;
      this.ao.updateGtaoMaterial({
        radius: g.ao.radius,
        distanceExponent: 1.6,
        thickness: 1.2,
        scale: 1.1,
        samples: 12,
      });
    }
    if (g.ssr && this.ssr) {
      this.ssr.opacity = g.ssr.intensity;
      this.ssr.maxDistance = g.ssr.maxDistance;
    }
    if (g.godRays && this.rays) this.rays.decay = g.godRays.decay;
    if (g.bloom && this.bloom) {
      this.bloom.threshold = g.bloom.threshold;
      this.bloom.strength = g.bloom.strength;
      this.bloom.radius = g.bloom.radius;
    }
    if (g.dof && this.dof) this.dof.set(g.dof.focusDistance, g.dof.aperture, g.dof.maxBlur);
    if (g.motionBlur && this.motion) {
      this.motion.strength = g.motionBlur.strength;
      this.motion.hidden = this.velocityHidden;
    }
    if (this.finish && (g.vignette || g.aberration || g.grain || g.grading)) {
      this.finish.set({
        aberration: g.aberration?.amount ?? 0,
        exposure: g.grading?.exposure ?? 0,
        contrast: g.grading?.contrast ?? 1,
        saturation: g.grading?.saturation ?? 1,
        temperature: g.grading?.temperature ?? 0,
        vignette: g.vignette?.amount ?? 0,
        vignetteSoftness: g.vignette?.softness ?? 0.5,
        grain: g.grain?.amount ?? 0,
      });
    }
  }

  setSize(w: number, h: number, pixelRatio: number): void {
    this.width = w;
    this.height = h;
    this.pixelRatio = pixelRatio;
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(w, h);
    // Passes that are not in the composer right now keep their old size: refresh them when they come back.
    for (const p of [this.ao, this.ssr, this.bloom, this.dof, this.motion]) {
      if (p && !this.composer.passes.includes(p)) p.setSize(w * pixelRatio, h * pixelRatio);
    }
  }

  /** Per frame, before `render`: feed what the effects need from the live scene. */
  prepare(): void {
    const g = this.resolved;
    if (!g) return;
    if (g.dof?.focusMode === 'target' && this.dof) this.dof.set(this.focusDistance, g.dof.aperture, g.dof.maxBlur);
    if (g.godRays && this.rays) this.updateShafts(g.godRays.intensity);
    if (g.ssr && this.ssr && this.ssr.selects !== this.reflectives) this.ssr.selects = this.reflectives;
  }

  private updateShafts(intensity: number): void {
    const rays = this.rays!;
    rays.sources.length = 0;
    const cam = this.camera;
    let n = 0;
    const sun = this.sun;
    if (sun && sun.visible && sun.intensity > 0) {
      const dir = this.sunDir(sun);
      this.tmpV.copy(cam.position).addScaledVector(dir, 1000).project(cam);
      // In front of the camera: a point 1000 m along the sun direction is behind the eye iff dir · view < 0.
      const forward = cam.getWorldDirection(this.fwd).dot(dir);
      if (forward > 0.02) {
        const s = this.sources[n++];
        s.uv.set(this.tmpV.x * 0.5 + 0.5, this.tmpV.y * 0.5 + 0.5);
        s.distance = Infinity;
        s.color.copy(sun.color);
        s.intensity = intensity * 0.35;
        rays.sources.push(s);
      }
    }
    if (++this.spotScan % 30 === 1) {
      this.spots.length = 0;
      this.scene.traverseVisible((o) => {
        if ((o as SpotLight).isSpotLight) this.spots.push(o as SpotLight);
      });
    }
    for (const sp of this.spots) {
      if (n >= this.sources.length || rays.sources.length >= 3) break;
      if (sp.intensity <= 0) continue;
      this.tmpV.setFromMatrixPosition(sp.matrixWorld);
      const view = this.viewV.copy(this.tmpV).applyMatrix4(cam.matrixWorldInverse);
      if (view.z > -0.1) continue;
      const depth = -view.z;
      this.tmpV.project(cam);
      const s = this.sources[n++];
      s.uv.set(this.tmpV.x * 0.5 + 0.5, this.tmpV.y * 0.5 + 0.5);
      s.distance = depth;
      s.color.copy(sp.color);
      s.intensity = intensity * 0.12;
      rays.sources.push(s);
    }
  }

  private readonly dirTmp = new Vector3();
  private readonly fwd = new Vector3();
  private readonly viewV = new Vector3();
  private sunDir(sun: DirectionalLight): Vector3 {
    return this.dirTmp.copy(sun.position).sub(sun.target.position).normalize();
  }

  render(dt: number): void {
    this.prepare();
    this.composer.render(dt);
    this.renderer.shadowMap.autoUpdate = true;
  }

  dispose(): void {
    this.composer.passes.length = 0;
    this.composer.dispose();
    for (const p of [
      this.ao,
      this.ssr,
      this.bloom,
      this.dof,
      this.rays,
      this.motion,
      this.finish,
      this.fxaa,
      this.smaa,
    ]) {
      p?.dispose();
    }
    this.output.dispose();
  }
}
