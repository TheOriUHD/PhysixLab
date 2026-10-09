/**
 * Viewport — owns the WebGL renderer, camera + navigation, lighting, environment, ground and
 * post-processing. Everything scene-specific (bodies, joints, overlays) is added by other
 * modules into the exposed groups.
 */
import {
  ACESFilmicToneMapping, AmbientLight, BackSide, BoxGeometry, Color, DirectionalLight, DoubleSide,
  Fog, Group, HalfFloatType, MathUtils, Mesh, MeshBasicMaterial, MeshStandardMaterial, MOUSE,
  PCFSoftShadowMap, PerspectiveCamera, PlaneGeometry, PMREMGenerator, Scene, ShaderMaterial,
  ShadowMaterial, SphereGeometry, Vector2, Vector3, WebGLRenderer, WebGLRenderTarget, type Object3D,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ViewHelper } from 'three/addons/helpers/ViewHelper.js';
import type { GroundSettings } from '../model/types';

export type Quality = 'low' | 'medium' | 'high';

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
  readonly camera: PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly dom: HTMLCanvasElement;

  /** Parent groups for the other render modules. */
  readonly bodies = new Group();
  readonly joints = new Group();
  readonly overlays = new Group();
  readonly helpers = new Group();

  private composer: EffectComposer;
  private renderPass: RenderPass;
  private outline: OutlinePass;
  private ao: GTAOPass | null = null;
  private output: OutputPass;
  private viewHelper: ViewHelper;
  private sun: DirectionalLight;
  private skyMesh: Mesh;
  private slab: Mesh;
  private grid: Mesh;
  private shadowCatcher: Mesh;
  private gridMat: ShaderMaterial;
  private quality: Quality = 'medium';
  private width = 1;
  private height = 1;
  private tween: { t: number; dur: number; fromPos: Vector3; toPos: Vector3; fromTarget: Vector3; toTarget: Vector3 } | null = null;
  private lastTime = performance.now();
  private resizeObserver: ResizeObserver;
  private shadowsOn = true;
  private aoOn = false;
  /** Called every frame before rendering with the frame delta in seconds. */
  onFrame: ((dt: number) => void) | null = null;
  needsRender = true;

  constructor(readonly container: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    this.dom = this.renderer.domElement;
    this.dom.className = 'viewport-canvas';
    this.dom.tabIndex = 0;
    container.appendChild(this.dom);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.camera = new PerspectiveCamera(48, 1, 0.05, 2000);
    this.camera.position.set(9, 7, 11);

    this.scene.fog = new Fog(0x1b2330, 60, 260);
    this.scene.add(this.bodies, this.joints, this.overlays, this.helpers);

    // ---- sky + environment ------------------------------------------------------------------
    const skyMat = new ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: {
        uZenith: { value: new Color('#0b1019') },
        uHorizon: { value: new Color('#27344a') },
        uGround: { value: new Color('#10151d') },
      },
      side: BackSide, depthWrite: false, fog: false,
    });
    this.skyMesh = new Mesh(new SphereGeometry(900, 32, 16), skyMat);
    this.skyMesh.frustumCulled = false;
    this.skyMesh.renderOrder = -10;
    this.scene.add(this.skyMesh);
    this.buildEnvironment();

    // ---- lights -----------------------------------------------------------------------------
    this.scene.add(new AmbientLight(0x8fa3c4, 0.18));
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
      vertexShader: GRID_VERT, fragmentShader: GRID_FRAG, transparent: true, depthWrite: false, side: DoubleSide,
      uniforms: { uCamPos: { value: new Vector3() }, uFadeDist: { value: 90 }, uHalf: { value: 60 } },
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.grid = new Mesh(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), this.gridMat);
    this.grid.position.y = 0.003;
    this.grid.renderOrder = 1;
    this.shadowCatcher = new Mesh(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new ShadowMaterial({ opacity: 0.42, color: 0x000000 }));
    this.shadowCatcher.position.y = 0.002;
    this.shadowCatcher.receiveShadow = true;
    this.scene.add(this.slab, this.grid, this.shadowCatcher);
    this.setGround({ enabled: true, friction: 0.8, restitution: 0.1, halfSize: 60, color: '#2b3038' });

    // ---- controls ---------------------------------------------------------------------------
    this.controls = new OrbitControls(this.camera, this.dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.zoomToCursor = true;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 0.4;
    this.controls.maxDistance = 400;
    this.controls.maxPolarAngle = Math.PI * 0.499;
    this.controls.mouseButtons = { LEFT: null as unknown as MOUSE, MIDDLE: MOUSE.PAN, RIGHT: MOUSE.ROTATE };
    this.controls.target.set(0, 1.2, 0);
    this.controls.addEventListener('change', () => (this.needsRender = true));
    // Alt + left drag also orbits (trackpads without a right button).
    this.dom.addEventListener('pointerdown', (e) => {
      this.controls.mouseButtons.LEFT = (e.altKey ? MOUSE.ROTATE : null) as unknown as MOUSE;
    }, true);
    this.dom.addEventListener('contextmenu', (e) => e.preventDefault());

    // ---- post-processing --------------------------------------------------------------------
    this.composer = this.makeComposer();
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.outline = new OutlinePass(new Vector2(1, 1), this.scene, this.camera);
    this.outline.edgeStrength = 4.5;
    this.outline.edgeGlow = 0.0;
    this.outline.edgeThickness = 1.6;
    this.outline.visibleEdgeColor.set('#5ec8ff');
    this.outline.hiddenEdgeColor.set('#1e5f8a');
    this.output = new OutputPass();
    this.rebuildPasses();

    this.viewHelper = new ViewHelper(this.camera, this.dom);
    this.viewHelper.center = this.controls.target;
    this.viewHelper.location = { top: 12, right: 12, bottom: 0, left: null } as ViewHelper['location'];

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.setQuality('medium');
  }

  // ------------------------------------------------------------------------------------------

  private makeComposer(): EffectComposer {
    const rt = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: this.quality === 'low' ? 0 : 4 });
    return new EffectComposer(this.renderer, rt);
  }

  private rebuildPasses(): void {
    const c = this.composer;
    c.passes.length = 0;
    c.addPass(this.renderPass);
    if (this.aoOn) {
      this.ao = this.ao ?? new GTAOPass(this.scene, this.camera, this.width, this.height);
      this.ao.output = GTAOPass.OUTPUT.Default;
      this.ao.blendIntensity = 0.9;
      this.ao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.6, thickness: 1.2, scale: 1.1, samples: 12 });
      this.ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 5, rings: 2, samples: 12 });
      c.addPass(this.ao);
    }
    c.addPass(this.outline);
    c.addPass(this.output);
    c.setSize(this.width, this.height);
  }

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
      const m = new Mesh(new PlaneGeometry(w, h), new MeshBasicMaterial({ color: new Color(tint).multiplyScalar(intensity), side: DoubleSide }));
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
    this.needsRender = true;
  }

  setQuality(q: Quality): void {
    this.quality = q;
    const sunMap = q === 'low' ? 1024 : q === 'medium' ? 2048 : 4096;
    this.shadowsOn = q !== 'low';
    this.aoOn = q === 'high';
    this.renderer.shadowMap.enabled = this.shadowsOn;
    this.sun.castShadow = this.shadowsOn;
    this.sun.shadow.mapSize.set(sunMap, sunMap);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
    this.renderer.setPixelRatio(q === 'low' ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    this.composer.dispose();
    this.composer = this.makeComposer();
    this.rebuildPasses();
    this.resize();
    // materials must recompile when shadows are toggled
    this.scene.traverse((o) => { const m = (o as Mesh).material as any; if (m && !Array.isArray(m)) m.needsUpdate = true; });
    this.needsRender = true;
  }

  get currentQuality(): Quality { return this.quality; }

  setOutlineTargets(objects: Object3D[], hover: Object3D[] = []): void {
    this.outline.selectedObjects = objects.concat(hover);
    this.needsRender = true;
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
    this.composer.setSize(w, h);
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
    this.tween = { t: 0, dur, fromPos: this.camera.position.clone(), toPos: pos, fromTarget: this.controls.target.clone(), toTarget: target };
  }

  /** Camera position + target, for persistence. */
  getView(): { position: [number, number, number]; target: [number, number, number] } {
    const p = this.camera.position, t = this.controls.target;
    return { position: [p.x, p.y, p.z], target: [t.x, t.y, t.z] };
  }

  setView(v: { position: [number, number, number]; target: [number, number, number] }): void {
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
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;

    if (this.tween) {
      const t = this.tween;
      t.t += dt;
      const k = Math.min(1, t.t / t.dur);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      this.camera.position.lerpVectors(t.fromPos, t.toPos, e);
      this.controls.target.lerpVectors(t.fromTarget, t.toTarget, e);
      if (k >= 1) this.tween = null;
    }
    if (this.viewHelper.animating) this.viewHelper.update(dt);
    const moved = this.controls.update(dt);
    void moved;

    this.onFrame?.(dt);

    // Keep sun shadow frustum centred on what the user is looking at.
    const tgt = this.controls.target;
    const dist = this.camera.position.distanceTo(tgt);
    const ext = MathUtils.clamp(dist * 0.9 + 14, 22, 70);
    const sc = this.sun.shadow.camera;
    if (sc.right !== ext) {
      sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext; sc.near = 1; sc.far = 220;
      sc.updateProjectionMatrix();
    }
    const texel = (ext * 2) / this.sun.shadow.mapSize.x;
    const snap = (v: number) => Math.round(v / texel) * texel;
    this.sun.target.position.set(snap(tgt.x), 0, snap(tgt.z));
    this.sun.position.set(this.sun.target.position.x - 38, 62, this.sun.target.position.z + 26);

    this.skyMesh.position.copy(this.camera.position);
    this.gridMat.uniforms.uCamPos.value.copy(this.camera.position);

    this.composer.render(dt);
    this.renderer.autoClear = false;
    this.viewHelper.render(this.renderer);
    this.renderer.autoClear = true;
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }
}
