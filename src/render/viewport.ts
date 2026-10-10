/**
 * Viewport — owns the WebGL renderer, camera + navigation, lighting, environment, ground and
 * post-processing. Everything scene-specific (bodies, joints, overlays) is added by other
 * modules into the exposed groups.
 */
import {
  ACESFilmicToneMapping,
  AmbientLight,
  BackSide,
  BoxGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Fog,
  Group,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  MOUSE,
  PCFShadowMap,
  PlaneGeometry,
  PMREMGenerator,
  Quaternion,
  Scene,
  ShaderMaterial,
  ShadowMaterial,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Object3D,
} from 'three';
import type { Material } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import { ViewHelper } from 'three/addons/helpers/ViewHelper.js';
import type { GroundSettings } from '../model/types';
import { EnvironmentController } from './environment';
// -- VZ-B: graphics settings, the post stack and the Auto governor (VZ-20..22) --
import {
  DEFAULT_GRAPHICS,
  probeTier,
  resolveGraphics,
  type GraphicsOptions,
  type QualityChoice,
  type QualityTier,
} from './graphics';
import { Governor } from './governor';
import { DEFAULT_HIGHLIGHT, PALETTES, SelectionDecor, type HighlightOptions } from './highlight';
import { PostStack } from './postStack';
import { DualCamera } from './dualCamera'; // -- CM-A --
import { ViewGrid, type ViewPlane } from './viewGrid'; // -- CM-A --
import { Weather } from './weather'; // -- VZ-B: weather (VZ-23) --
import { OTHER, RENDER, profiler } from '../core/profiler'; // -- UI-B: frame timing --

export type Quality = QualityChoice;

// -- CM-A: scratch values for the camera tween --
const TWEEN_A = new Vector3();
const TWEEN_B = new Vector3();
const TWEEN_Q = new Quaternion();
const TWEEN_Q2 = new Quaternion();

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * p;
  gl_Position.z = gl_Position.w; // pin to the far plane
}`;

const SKY_FRAG = /* glsl */ `
varying vec3 vDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
void main() {
  float h = vDir.y;
  vec3 col = h > 0.0 ? mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.55)) : mix(uHorizon, uGround, pow(clamp(-h, 0.0, 1.0), 0.4));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const GRID_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const GRID_FRAG = /* glsl */ `
varying vec3 vWorld;
uniform vec3 uCamPos;
uniform float uFadeDist;
uniform float uHalf;
float line(vec2 p, float scale) {
  vec2 q = p / scale;
  vec2 g = abs(fract(q - 0.5) - 0.5) / max(fwidth(q), vec2(1e-5));
  return 1.0 - clamp(min(g.x, g.y), 0.0, 1.0);
}
void main() {
  vec2 p = vWorld.xz;
  float minor = line(p, 1.0);
  float major = line(p, 10.0);
  float d = distance(vWorld.xz, uCamPos.xz);
  float fade = 1.0 - smoothstep(uFadeDist * 0.35, uFadeDist, d);
  float edge = smoothstep(uHalf, uHalf - 1.5, max(abs(p.x), abs(p.y)));
  vec3 col = vec3(0.62, 0.72, 0.86);
  float a = minor * 0.10 + major * 0.20;
  // world axes
  float ax = 1.0 - clamp(abs(p.y) / max(fwidth(p.y) * 1.2, 1e-5), 0.0, 1.0); // x axis (z = 0)
  float az = 1.0 - clamp(abs(p.x) / max(fwidth(p.x) * 1.2, 1e-5), 0.0, 1.0); // z axis (x = 0)
  col = mix(col, vec3(0.95, 0.35, 0.35), ax);
  col = mix(col, vec3(0.35, 0.55, 0.98), az);
  a = max(a, max(ax, az) * 0.55);
  a *= fade * edge;
  if (a < 0.002) discard;
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}`;

export class Viewport {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: DualCamera;
  readonly controls: OrbitControls;
  readonly dom: HTMLCanvasElement;

  /** Parent groups for the other render modules. */
  readonly bodies = new Group();
  readonly softs = new Group();
  readonly joints = new Group();
  readonly overlays = new Group();
  readonly helpers = new Group();
  // ── FB-6: group / light / path views ──
  readonly groups = new Group();
  readonly lights = new Group();
  readonly paths = new Group();

  // -- VZ-B: post stack (src/render/postStack.ts) --
  readonly post: PostStack;
  readonly outline: OutlinePass;
  readonly outlineHover: OutlinePass;
  readonly outlineLinked: OutlinePass;
  // -- VZ-B: highlight (VZ-40) --
  private highlight: HighlightOptions = DEFAULT_HIGHLIGHT;
  private multiSelect = false;
  readonly decor = new SelectionDecor();
  // -- VZ-B: weather --
  readonly weather: Weather;
  private graphics: GraphicsOptions = DEFAULT_GRAPHICS;
  private governor: Governor | null = null;
  private probedTier: QualityTier = 'high';
  private activeTier: QualityTier = 'medium';
  private pixelRatioNow = 1;
  private viewHelper: ViewHelper;
  // -- VZ-A: environment controller (src/render/environment.ts) and the direction the sun shines from --
  env!: EnvironmentController;
  readonly sunDir = new Vector3(-38, 62, 26).normalize();
  ambient!: AmbientLight;
  sun: DirectionalLight;
  skyMesh: Mesh;
  slab: Mesh;
  grid: Mesh;
  shadowCatcher: Mesh;
  gridMat: ShaderMaterial;
  private quality: Quality = 'medium';
  private width = 1;
  private height = 1;
  private tween: {
    t: number;
    dur: number;
    fromPos: Vector3;
    toPos: Vector3;
    fromTarget: Vector3;
    toTarget: Vector3;
  } | null = null;
  private lastTime = performance.now();
  private resizeObserver: ResizeObserver;
  // -- CM-A: a camera rig drives `camera` itself (fly, first person …): the tween and orbit controls stand aside --
  externalCamera = false;
  readonly viewGrid = new ViewGrid();
  private viewPlane: ViewPlane = null;
  private thumbRequests: { w: number; h: number; done: (url: string | null) => void }[] = [];
  /** Called every frame before rendering with the frame delta in seconds. */
  onFrame: ((dt: number) => void) | null = null;
  needsRender = true;

  constructor(readonly container: HTMLElement) {
    this.renderer = new WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    this.dom = this.renderer.domElement;
    this.dom.className = 'viewport-canvas';
    this.dom.tabIndex = 0;
    container.appendChild(this.dom);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.camera = new DualCamera(48, 1, 0.05, 2000);
    this.camera.position.set(9, 7, 11);

    this.scene.fog = new Fog(0x1b2330, 60, 260);
    this.scene.add(
      this.bodies,
      this.softs,
      this.joints,
      this.overlays,
      this.helpers,
      this.groups,
      this.lights,
      this.paths,
    );

    // ---- sky + environment ------------------------------------------------------------------
    const skyMat = new ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: {
        uZenith: { value: new Color('#0b1019') },
        uHorizon: { value: new Color('#27344a') },
        uGround: { value: new Color('#10151d') },
      },
      side: BackSide,
      depthWrite: false,
      fog: false,
    });
    this.skyMesh = new Mesh(new SphereGeometry(900, 32, 16), skyMat);
    this.skyMesh.frustumCulled = false;
    this.skyMesh.renderOrder = -10;
    this.scene.add(this.skyMesh);
    this.buildEnvironment();

    // ---- lights -----------------------------------------------------------------------------
    this.ambient = new AmbientLight(0x8fa3c4, 0.18);
    this.scene.add(this.ambient);
    this.sun = new DirectionalLight(0xfff3e0, 3.2);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0003;
    this.sun.shadow.normalBias = 0.035;
    this.sun.shadow.radius = 3;
    this.sun.shadow.blurSamples = 12;
    this.scene.add(this.sun, this.sun.target);

    // ---- ground -----------------------------------------------------------------------------
    this.slab = new Mesh(
      new BoxGeometry(1, 1, 1),
      new MeshStandardMaterial({ color: '#2b3038', roughness: 0.92, metalness: 0.0 }),
    );
    this.slab.receiveShadow = true;
    this.gridMat = new ShaderMaterial({
      vertexShader: GRID_VERT,
      fragmentShader: GRID_FRAG,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      uniforms: { uCamPos: { value: new Vector3() }, uFadeDist: { value: 90 }, uHalf: { value: 60 } },
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.grid = new Mesh(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), this.gridMat);
    this.grid.position.y = 0.003;
    this.grid.renderOrder = 1;
    this.shadowCatcher = new Mesh(
      new PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new ShadowMaterial({ opacity: 0.42, color: 0x000000 }),
    );
    this.shadowCatcher.position.y = 0.002;
    this.shadowCatcher.receiveShadow = true;
    this.scene.add(this.slab, this.grid, this.shadowCatcher, this.viewGrid.mesh);
    this.setGround({ enabled: true, friction: 0.8, restitution: 0.1, halfSize: 60, color: '#2b3038' });
    this.weather = new Weather(this.scene, container, this.bodies, this.slab.material as Material); // -- VZ-B: weather --

    // ---- controls ---------------------------------------------------------------------------
    this.controls = new OrbitControls(this.camera, this.dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.zoomToCursor = true;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 0.4;
    this.controls.maxDistance = 400;
    this.controls.maxPolarAngle = Math.PI * 0.499;
    this.controls.mouseButtons = { LEFT: null, MIDDLE: MOUSE.PAN, RIGHT: MOUSE.ROTATE };
    this.controls.target.set(0, 1.2, 0);
    this.controls.addEventListener('change', () => (this.needsRender = true));
    // Alt + left drag also orbits (trackpads without a right button).
    this.dom.addEventListener(
      'pointerdown',
      (e) => {
        this.controls.mouseButtons.LEFT = e.altKey ? MOUSE.ROTATE : null;
      },
      true,
    );
    this.dom.addEventListener('contextmenu', (e) => e.preventDefault());

    // ---- post-processing --------------------------------------------------------------------
    this.outline = new OutlinePass(new Vector2(1, 1), this.scene, this.camera);
    this.outline.edgeStrength = 4.5;
    this.outline.edgeGlow = 0.0;
    this.outline.edgeThickness = 1.6;
    this.outline.visibleEdgeColor.set('#5ec8ff');
    this.outline.hiddenEdgeColor.set('#1e5f8a');
    const mk = () => {
      const p = new OutlinePass(new Vector2(1, 1), this.scene, this.camera);
      p.edgeStrength = 4.5;
      p.edgeGlow = 0;
      p.edgeThickness = 1.6;
      return p;
    };
    this.outlineHover = mk();
    this.outlineLinked = mk();
    this.outlineHover.edgeStrength = 3.5;
    this.outlineLinked.edgeStrength = 3.2;
    this.post = new PostStack(this.renderer, this.scene, this.camera, [
      this.outline,
      this.outlineHover,
      this.outlineLinked,
    ]);
    this.helpers.add(this.decor.group);
    this.setHighlightStyle(DEFAULT_HIGHLIGHT);
    this.post.sun = this.sun;
    this.post.velocityHidden = [
      this.overlays,
      this.helpers,
      this.joints,
      this.groups,
      this.lights,
      this.paths,
      this.skyMesh,
    ];
    this.probedTier = probeTier(this.gpuString(), isMobile());

    this.viewHelper = new ViewHelper(this.camera, this.dom);
    this.viewHelper.center = this.controls.target;
    this.viewHelper.location = { top: 12, right: 12, bottom: 0, left: null };

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.setQuality('auto');
    this.env = new EnvironmentController(this); // -- VZ-A --
  }

  // ------------------------------------------------------------------------------------------

  private buildEnvironment(): void {
    const pmrem = new PMREMGenerator(this.renderer);
    const env = new Scene();
    const sky = new Mesh(
      new SphereGeometry(50, 32, 16),
      new ShaderMaterial({
        vertexShader: `varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
        fragmentShader: `varying vec3 vP; void main(){
          float h = vP.y;
          vec3 top = vec3(0.10, 0.14, 0.24); vec3 mid = vec3(0.30, 0.38, 0.52); vec3 low = vec3(0.07, 0.08, 0.10);
          vec3 c = h > 0.0 ? mix(mid, top, pow(h, 0.6)) : mix(mid, low, pow(-h, 0.5));
          gl_FragColor = vec4(c * 1.2, 1.0); }`,
        side: BackSide,
      }),
    );
    env.add(sky);
    const panel = (w: number, h: number, pos: Vector3, intensity: number, tint: number) => {
      const m = new Mesh(
        new PlaneGeometry(w, h),
        new MeshBasicMaterial({ color: new Color(tint).multiplyScalar(intensity), side: DoubleSide }),
      );
      m.position.copy(pos);
      m.lookAt(0, 0, 0);
      env.add(m);
    };
    panel(30, 18, new Vector3(-20, 30, 15), 9, 0xfff1de); // key softbox
    panel(18, 10, new Vector3(25, 12, -18), 3.2, 0x9ec5ff); // cool rim
    panel(40, 6, new Vector3(0, 8, 30), 1.6, 0xffffff); // fill strip
    this.scene.environment = pmrem.fromScene(env, 0.03).texture;
    this.scene.environmentIntensity = 0.85;
    pmrem.dispose();
  }

  setGround(g: GroundSettings): void {
    const size = g.halfSize * 2;
    this.slab.visible = this.grid.visible = this.shadowCatcher.visible = g.enabled;
    this.slab.scale.set(size, 2, size);
    this.slab.position.y = -1;
    (this.slab.material as MeshStandardMaterial).color.set(g.color);
    this.grid.scale.set(size, 1, size);
    this.shadowCatcher.scale.set(size, 1, size);
    this.gridMat.uniforms.uHalf.value = g.halfSize;
    this.env?.onGround(g); // -- VZ-A: ground type + horizon blend --
    this.needsRender = true;
  }

  /** The WebGL renderer string ("ANGLE (NVIDIA …)", "SwiftShader" …) for the Auto tier probe. */
  private gpuString(): string {
    try {
      const gl = this.renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    } catch {
      return '';
    }
  }

  /** Choose a quality tier — or 'auto', which lets the governor pick and adapt (VZ-22). */
  setQuality(q: Quality): void {
    this.quality = q;
    if (q === 'auto') {
      this.governor = new Governor(this.probedTier);
      this.activeTier = this.governor.step.tier;
    } else {
      this.governor = null;
      this.activeTier = q;
    }
    this.applyGraphics();
  }

  /** The user's per-effect options (prefs). */
  setGraphics(g: GraphicsOptions): void {
    this.graphics = g;
    this.applyGraphics();
  }

  /** Resolve tier + options and push the result into the renderer, the shadow system and the post stack. */
  private applyGraphics(): void {
    const tier = this.governor ? this.governor.step.tier : this.activeTier;
    this.activeTier = tier;
    let g = resolveGraphics(this.graphics, tier, this.renderer.capabilities.maxSamples);
    // -- CM-A: depth-of-field, ambient occlusion, reflections, shafts and motion blur assume a perspective lens --
    if (this.camera.ortho) g = { ...g, ao: null, ssr: null, godRays: null, dof: null, motionBlur: null };
    this.resolvedGraphics = g;
    this.renderer.shadowMap.enabled = g.shadows.enabled;
    this.sun.castShadow = g.shadows.enabled;
    const res = g.shadows.resolution;
    if (this.sun.shadow.mapSize.x !== res) {
      this.sun.shadow.mapSize.set(res, res);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.sun.shadow.radius = 1 + g.shadows.softness * 5;
    const dpr = Math.min(window.devicePixelRatio || 1, g.pixelRatioCap);
    const pr = Math.max(0.5, dpr * this.graphics.resolutionScale * (this.governor ? this.governor.step.scale : 1));
    this.pixelRatioNow = pr;
    this.renderer.setPixelRatio(pr);
    this.post.setSize(this.width, this.height, pr);
    const before = this.post.currentSignature;
    this.post.configure(g);
    if (before !== this.post.currentSignature || this.lastShadowsOn !== g.shadows.enabled) {
      // materials must recompile when shadows are toggled
      this.scene.traverse((o) => {
        const m: Material | Material[] = (o as Mesh).material;
        if (m && !Array.isArray(m)) m.needsUpdate = true;
      });
    }
    this.lastShadowsOn = g.shadows.enabled;
    this.needsRender = true;
  }

  private lastShadowsOn = true;
  // -- VZ-B: shadow frustum snapping (VZ-32) --
  private readonly lightRight = new Vector3();
  private readonly lightUp = new Vector3();
  resolvedGraphics = resolveGraphics(DEFAULT_GRAPHICS, 'medium');

  /** The tier actually in force (differs from the chosen quality under Auto) and the live governor state. */
  get graphicsInfo(): { tier: QualityTier; auto: boolean; pixelRatio: number; frameMs: number; probe: QualityTier } {
    return {
      tier: this.activeTier,
      auto: this.governor !== null,
      pixelRatio: this.pixelRatioNow,
      frameMs: this.governor?.averageMs ?? 0,
      probe: this.probedTier,
    };
  }

  get currentQuality(): Quality {
    return this.quality;
  }

  /**
   * Selection outline (colour by selection kind), hover outline and linked-entity outline are three passes, each
   * only doing work while it has objects (VZ-40).
   */
  setOutlineTargets(objects: Object3D[], hover: Object3D[] = [], linked: Object3D[] = []): void {
    this.multiSelect = objects.length > 1;
    this.outline.selectedObjects = objects;
    this.outlineHover.selectedObjects = hover;
    this.outlineLinked.selectedObjects = linked;
    this.outline.enabled = objects.length > 0;
    this.outlineHover.enabled = hover.length > 0;
    this.outlineLinked.enabled = linked.length > 0;
    this.paintOutlines();
    this.decor.update(objects, this.highlight.bbox, this.highlight.axes);
    this.needsRender = true;
  }

  /** Palette, pulse, bounding box / axes options. */
  setHighlightStyle(o: HighlightOptions): void {
    this.highlight = o;
    this.paintOutlines();
    this.outline.pulsePeriod = o.pulse ? 1.6 : 0;
    this.decor.update(this.outline.selectedObjects, o.bbox, o.axes);
    this.needsRender = true;
  }

  private paintOutlines(): void {
    const pal = PALETTES[this.highlight.palette];
    const paint = (p: OutlinePass, css: string) => {
      p.visibleEdgeColor.set(css);
      p.hiddenEdgeColor.set(css).multiplyScalar(pal.hiddenFactor);
    };
    paint(this.outline, this.multiSelect ? pal.multi : pal.selected);
    paint(this.outlineHover, pal.hover);
    paint(this.outlineLinked, pal.linked);
    this.decor.setColor(this.multiSelect ? pal.multi : pal.selected);
  }

  resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.dom.style.width = '100%';
    this.dom.style.height = '100%';
    this.post.setSize(w, h, this.pixelRatioNow);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.needsRender = true;
  }

  // ---- camera helpers ----------------------------------------------------------------------

  /** Smoothly move the camera so a sphere of `radius` around `center` fills the view. */
  frame(center: Vector3, radius: number, keepDirection = true): void {
    const dist = Math.max(2.2, (radius / Math.tan(MathUtils.degToRad(this.camera.fov / 2))) * 1.35);
    const dir = keepDirection
      ? this.camera.position.clone().sub(this.controls.target).normalize()
      : new Vector3(0.62, 0.5, 0.78).normalize();
    this.flyTo(center.clone().add(dir.multiplyScalar(dist)), center.clone());
  }

  flyTo(pos: Vector3, target: Vector3, dur = 0.45): void {
    this.tween = {
      t: 0,
      dur,
      fromPos: this.camera.position.clone(),
      toPos: pos,
      fromTarget: this.controls.target.clone(),
      toTarget: target,
    };
  }

  /** Camera position + target, for persistence. */
  getView(): { position: [number, number, number]; target: [number, number, number] } {
    const p = this.camera.position,
      t = this.controls.target;
    return { position: [p.x, p.y, p.z], target: [t.x, t.y, t.z] };
  }

  setView(v: { position: [number, number, number]; target: [number, number, number] }): void {
    this.tween = null;
    this.camera.position.set(...v.position);
    this.controls.target.set(...v.target);
    this.controls.update();
  }

  handleViewHelperClick(e: MouseEvent): boolean {
    return this.viewHelper.handleClick(e);
  }

  // ---- loop ---------------------------------------------------------------------------------

  start(): void {
    const loop = () => {
      requestAnimationFrame(loop);
      this.frameOnce();
    };
    requestAnimationFrame(loop);
  }

  private frameOnce(): void {
    profiler.begin(); // -- UI-B: frame timing --
    const now = performance.now();
    const rawDt = (now - this.lastTime) / 1000;
    const dt = Math.min(0.1, rawDt);
    this.lastTime = now;
    if (this.governor?.update(rawDt)) this.applyGraphics(); // -- VZ-B: Auto governor --

    if (this.tween && !this.externalCamera) {
      const t = this.tween;
      t.t += dt;
      const k = Math.min(1, t.t / t.dur);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      this.controls.target.lerpVectors(t.fromTarget, t.toTarget, e);
      // -- CM-A: swing around the target instead of cutting through it when the direction changes a lot --
      const r0 = TWEEN_A.subVectors(t.fromPos, t.fromTarget);
      const r1 = TWEEN_B.subVectors(t.toPos, t.toTarget);
      const l0 = r0.length();
      const l1 = r1.length();
      if (l0 > 1e-6 && l1 > 1e-6 && r0.angleTo(r1) > 0.35) {
        TWEEN_Q.setFromUnitVectors(r0.multiplyScalar(1 / l0), r1.multiplyScalar(1 / l1));
        TWEEN_Q2.identity().slerp(TWEEN_Q, e);
        this.camera.position
          .copy(r0)
          .applyQuaternion(TWEEN_Q2)
          .multiplyScalar(l0 + (l1 - l0) * e)
          .add(this.controls.target);
      } else {
        this.camera.position.lerpVectors(t.fromPos, t.toPos, e);
      }
      if (k >= 1) this.tween = null;
    }
    if (this.viewHelper.animating) this.viewHelper.update(dt);
    if (!this.externalCamera) {
      const moved = this.controls.update(dt);
      void moved;
    }

    profiler.mark(OTHER); // -- UI-B: frame timing --
    this.onFrame?.(dt);

    // Keep sun shadow frustum centred on what the user is looking at (VZ-32): the extent is quantised so the texel
    // size only changes in steps while zooming, the High / Ultra tiers use a tighter frustum (sharper contact
    // shadows near the focus), and the centre snaps to whole texels *in light space* so shadows do not crawl.
    const tgt = this.controls.target;
    const dist = this.camera.position.distanceTo(tgt);
    const tight = this.resolvedGraphics.shadows.contactHardening ? 0.65 : 1;
    const ext = Math.ceil(MathUtils.clamp((dist * 0.9 + 14) * tight, 14, 70) / 4) * 4;
    const sc = this.sun.shadow.camera;
    if (sc.right !== ext) {
      sc.left = -ext;
      sc.right = ext;
      sc.top = ext;
      sc.bottom = -ext;
      sc.near = 1;
      sc.far = 220;
      sc.updateProjectionMatrix();
    }
    const texel = (ext * 2) / this.sun.shadow.mapSize.x;
    const d = this.sunDir;
    this.lightRight.set(0, 1, 0).cross(d).normalize();
    this.lightUp.copy(d).cross(this.lightRight);
    const t = this.sun.target.position.set(tgt.x, 0, tgt.z);
    const u = t.dot(this.lightRight);
    const v = t.dot(this.lightUp);
    t.addScaledVector(this.lightRight, Math.round(u / texel) * texel - u).addScaledVector(
      this.lightUp,
      Math.round(v / texel) * texel - v,
    );
    this.sun.position.copy(t).addScaledVector(d, 70);

    this.skyMesh.position.copy(this.camera.position);
    this.env.followCamera(this.camera.position);
    this.env.tick(dt); // -- VZ-A --
    // An orthographic camera sits far away: fade the ground grid around what is looked at instead.
    (this.gridMat.uniforms.uCamPos.value as Vector3).copy(this.camera.ortho ? tgt : this.camera.position);
    this.updateViewGrid();

    profiler.mark(OTHER); // -- UI-B: frame timing --
    this.post.focusDistance = this.camera.position.distanceTo(this.controls.target);
    this.weather.update(dt, this.camera, this.controls.target, this.activeTier); // -- VZ-B: weather --
    this.post.render(dt);
    this.renderer.autoClear = false;
    this.viewHelper.render(this.renderer);
    this.renderer.autoClear = true;
    profiler.mark(RENDER); // -- UI-B: frame timing --
    profiler.end(); // -- UI-B: frame timing --
    if (this.thumbRequests.length) this.flushThumbnails();
  }

  /** A small JPEG data URL of the next rendered frame (cropped to w:h), or null when it cannot be made. */
  captureThumbnail(w: number, h: number): Promise<string | null> {
    return new Promise((done) => {
      this.thumbRequests.push({ w, h, done });
      this.needsRender = true;
    });
  }

  private flushThumbnails(): void {
    const reqs = this.thumbRequests;
    this.thumbRequests = [];
    for (const r of reqs) {
      try {
        const c = document.createElement('canvas');
        c.width = r.w;
        c.height = r.h;
        const ctx = c.getContext('2d');
        if (!ctx) {
          r.done(null);
          continue;
        }
        const sw = this.dom.width;
        const sh = this.dom.height;
        const want = r.w / r.h;
        let cw = sw;
        let ch = sw / want;
        if (ch > sh) {
          ch = sh;
          cw = sh * want;
        }
        ctx.drawImage(this.dom, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, r.w, r.h);
        let url = c.toDataURL('image/jpeg', 0.7);
        if (url.length > 22000) url = c.toDataURL('image/jpeg', 0.4);
        r.done(url.length <= 22000 ? url : null);
      } catch {
        r.done(null);
      }
    }
  }

  // ---- CM-A: projection -------------------------------------------------------------------------

  /** Switch between perspective and orthographic projection (same camera object). */
  setProjection(ortho: boolean, size?: number): void {
    const cam = this.camera;
    const changed = cam.ortho !== ortho;
    cam.ortho = ortho;
    if (size !== undefined) cam.orthoSize = Math.max(0.1, size);
    cam.zoom = 1;
    cam.updateProjectionMatrix();
    if (changed) this.applyGraphics(); // the perspective-only passes drop out (and come back) with the projection
    this.needsRender = true;
  }

  /** The plane of the extra grid in an orthographic front / side view (null = none). */
  setViewPlane(plane: ViewPlane): void {
    this.viewPlane = plane;
    if (!plane) this.viewGrid.mesh.visible = false;
    this.needsRender = true;
  }

  private updateViewGrid(): void {
    const cam = this.camera;
    if (!cam.ortho || !this.viewPlane) {
      if (this.viewGrid.mesh.visible) this.viewGrid.set(null, this.controls.target, 1, 1);
      return;
    }
    const visible = cam.orthoSize / Math.max(1e-6, cam.zoom);
    // 1 m lines while they are at least a few pixels apart, 10 m lines when zoomed far out.
    const step = visible > 160 ? 10 : visible > 16 ? 1 : visible > 1.6 ? 0.1 : 0.01;
    this.viewGrid.set(this.viewPlane, this.controls.target, visible * 2.2, step);
  }

  dispose(): void {
    this.viewGrid.dispose();
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.weather.dispose(); // -- VZ-B: weather --
    this.post.dispose();
    this.renderer.dispose();
  }
}

/** Phones and tablets start Auto one tier lower. */
function isMobile(): boolean {
  return typeof navigator !== 'undefined' && /android|iphone|ipad|mobile/i.test(navigator.userAgent);
}
