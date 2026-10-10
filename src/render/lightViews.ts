/**
 * Light views: every `LightEntity` becomes a real three.js light (point, spot, directional or rect-area) with the
 * entity's colour / intensity / range / cone, plus an editor helper — a screen-sized icon sprite you can click and a
 * wire sketch of what the light does (spot cone, directional arrow, area rectangle, point range). Later visual
 * packages extend this file (shadow quality, IES profiles, volumetrics …); the physics knows nothing about lights.
 *
 * Every lit surface pays for every light, so only the first `MAX_REAL_LIGHTS` enabled lights are real (and the first
 * `MAX_SHADOW_LIGHTS` of those cast shadows); the others keep their helper and are marked in `overBudget`.
 */
import {
  BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  PointLight,
  RectAreaLight,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
  SpotLight,
  type Object3D,
} from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import type { LightEntity, LightType } from '../model/types';
import { iconDataUrl } from '../ui/icons';

/** The three.js light classes a `LightEntity` maps to. */
export type RealLight = PointLight | SpotLight | DirectionalLight | RectAreaLight;
type ShadowedLight = PointLight | SpotLight | DirectionalLight;

export const MAX_REAL_LIGHTS = 8;
export const MAX_SHADOW_LIGHTS = 3;

const GLYPH: Record<LightType, string> = {
  point: 'light',
  spot: 'lightSpot',
  directional: 'lightSun',
  area: 'lightArea',
};

const glyphs = new Map<string, CanvasTexture>();

/** Dark disc with the light's icon in white (the sprite material tints the icon with the light's colour). */
function glyphTexture(name: string): CanvasTexture {
  let tex = glyphs.get(name);
  if (tex) return tex;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  const draw = (img: HTMLImageElement | null) => {
    const c = canvas.getContext('2d');
    if (!c) return;
    c.clearRect(0, 0, 128, 128);
    c.fillStyle = 'rgba(16, 22, 32, 0.92)';
    c.beginPath();
    c.arc(64, 64, 60, 0, Math.PI * 2);
    c.fill();
    c.lineWidth = 5;
    c.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    c.stroke();
    if (img) c.drawImage(img, 26, 26, 76, 76);
    if (tex) tex.needsUpdate = true;
  };
  draw(null);
  const img = new Image();
  img.onload = () => draw(img);
  img.src = iconDataUrl(name, '#ffffff');
  glyphs.set(name, tex);
  return tex;
}

let areaLibReady = false;

/** Wire sketch of the light in its local frame (it shines along −Z). */
function sketch(def: LightEntity): Float32Array {
  const v: number[] = [];
  const seg = (a: number[], b: number[]) => v.push(...a, ...b);
  const ring = (cx: number, cy: number, cz: number, r: number, axis: 'z' | 'x' | 'y', n = 40) => {
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 1) / n) * Math.PI * 2;
      const p = (a: number) =>
        axis === 'z'
          ? [cx + r * Math.cos(a), cy + r * Math.sin(a), cz]
          : axis === 'x'
            ? [cx, cy + r * Math.cos(a), cz + r * Math.sin(a)]
            : [cx + r * Math.cos(a), cy, cz + r * Math.sin(a)];
      seg(p(a0), p(a1));
    }
  };
  switch (def.lightType) {
    case 'point':
      if (def.range > 0) {
        ring(0, 0, 0, def.range, 'x');
        ring(0, 0, 0, def.range, 'y');
        ring(0, 0, 0, def.range, 'z');
      }
      break;
    case 'spot': {
      const d = def.range > 0 ? Math.min(def.range, 4) : 3;
      const r = Math.tan(def.angle) * d;
      ring(0, 0, -d, r, 'z');
      for (const [x, y] of [
        [r, 0],
        [-r, 0],
        [0, r],
        [0, -r],
      ])
        seg([0, 0, 0], [x, y, -d]);
      break;
    }
    case 'directional': {
      seg([0, 0, 0], [0, 0, -2]);
      seg([0, 0, -2], [0.12, 0, -1.7]);
      seg([0, 0, -2], [-0.12, 0, -1.7]);
      seg([0, 0, -2], [0, 0.12, -1.7]);
      seg([0, 0, -2], [0, -0.12, -1.7]);
      ring(0, 0, 0, 0.35, 'z');
      break;
    }
    case 'area': {
      const w = def.size[0] / 2;
      const h = def.size[1] / 2;
      seg([-w, -h, 0], [w, -h, 0]);
      seg([w, -h, 0], [w, h, 0]);
      seg([w, h, 0], [-w, h, 0]);
      seg([-w, h, 0], [-w, -h, 0]);
      seg([0, 0, 0], [0, 0, -0.9]);
      seg([0, 0, -0.9], [0.1, 0, -0.7]);
      seg([0, 0, -0.9], [-0.1, 0, -0.7]);
      break;
    }
  }
  return new Float32Array(v);
}

export class LightView {
  readonly root = new Group();
  /** The real three.js light (null while it is over the render budget). */
  light: RealLight | null = null;
  readonly sprite: Sprite;
  private readonly wire: LineSegments;
  private readonly wireMat = new LineBasicMaterial({ transparent: true, opacity: 0.55, depthTest: false });
  selected = false;
  /** More lights are enabled than the renderer lights for: this one only has its helper. */
  overBudget = false;
  /** Whether this light is currently allowed to cast shadows (budget). */
  shadowAllowed = true;

  constructor(public def: LightEntity) {
    this.sprite = new Sprite(
      new SpriteMaterial({
        map: glyphTexture(GLYPH[def.lightType]),
        sizeAttenuation: false,
        depthTest: false,
        transparent: true,
      }),
    );
    this.sprite.scale.setScalar(0.05);
    this.sprite.renderOrder = 1000;
    this.sprite.userData.entityId = def.id;
    this.wire = new LineSegments(new BufferGeometry(), this.wireMat);
    this.wire.renderOrder = 999;
    this.wire.raycast = () => undefined; // the sprite is the click target
    this.wire.frustumCulled = false;
    this.root.add(this.sprite, this.wire);
    this.build();
    this.apply(def);
  }

  /** (Re)create the real light for the entity's type. */
  private build(): void {
    if (this.light) {
      this.root.remove(this.light);
      if (!(this.light instanceof PointLight) && !(this.light instanceof RectAreaLight))
        this.root.remove(this.light.target);
      this.light.dispose();
      this.light = null;
    }
    const d = this.def;
    switch (d.lightType) {
      case 'point':
        this.light = new PointLight(d.color, d.intensity, d.range, 2);
        break;
      case 'spot': {
        const s = new SpotLight(d.color, d.intensity, d.range, d.angle, d.penumbra, 2);
        s.target.position.set(0, 0, -1);
        this.root.add(s.target);
        this.light = s;
        break;
      }
      case 'directional': {
        const l = new DirectionalLight(d.color, d.intensity);
        l.target.position.set(0, 0, -1);
        l.shadow.camera.left = l.shadow.camera.bottom = -30;
        l.shadow.camera.right = l.shadow.camera.top = 30;
        l.shadow.camera.near = 0.5;
        l.shadow.camera.far = 120;
        this.root.add(l.target);
        this.light = l;
        break;
      }
      case 'area':
        if (!areaLibReady) {
          RectAreaLightUniformsLib.init();
          areaLibReady = true;
        }
        this.light = new RectAreaLight(d.color, d.intensity, d.size[0], d.size[1]);
        break;
    }
    this.light.userData.lightEntity = d.id;
    this.root.add(this.light);
  }

  /** Bring the three.js objects in line with `def` (a changed type rebuilds the light). */
  apply(def: LightEntity): void {
    const retyped = def.lightType !== this.def.lightType;
    this.def = def;
    if (retyped) {
      this.build();
      this.sprite.material.map = glyphTexture(GLYPH[def.lightType]);
    }
    this.sprite.userData.entityId = def.id;
    this.root.position.set(...def.position);
    this.root.quaternion.set(...def.rotation);
    const l = this.light;
    if (l) {
      l.color.set(def.color);
      l.intensity = def.intensity;
      if (l instanceof PointLight || l instanceof SpotLight) l.distance = def.range;
      if (l instanceof SpotLight) {
        l.angle = def.angle;
        l.penumbra = def.penumbra;
      }
      if (l instanceof RectAreaLight) {
        l.width = def.size[0];
        l.height = def.size[1];
      }
    }
    this.wire.geometry.dispose();
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(sketch(def), 3));
    this.wire.geometry = g;
    this.refreshState();
  }

  /** Visibility / shadows / colours that depend on enabled, hidden, selection and the render budget. */
  refreshState(): void {
    const def = this.def;
    const emitting = def.enabled && !def.hidden;
    if (this.light) {
      this.light.visible = emitting && !this.overBudget;
      if (!(this.light instanceof RectAreaLight)) this.setShadow(this.light, def.castShadow && this.shadowAllowed);
    }
    this.root.visible = !def.hidden;
    const mat = this.sprite.material;
    mat.color.set(emitting ? def.color : '#6b7686');
    mat.opacity = emitting ? 1 : 0.6;
    this.sprite.scale.setScalar(this.selected ? 0.062 : 0.05);
    this.wireMat.color.set(this.selected ? '#ffffff' : emitting ? def.color : '#6b7686');
    this.wireMat.opacity = this.selected ? 0.95 : 0.5;
  }

  /** Rect-area lights cannot cast shadows in three.js; the others get a map sized for their kind. */
  private setShadow(l: ShadowedLight, on: boolean): void {
    l.castShadow = on;
    if (on && !l.shadow.map) {
      const size = l instanceof PointLight ? 512 : l instanceof DirectionalLight ? 2048 : 1024;
      l.shadow.mapSize.set(size, size);
      l.shadow.bias = -0.0004;
      l.shadow.normalBias = 0.03;
    }
  }

  dispose(): void {
    this.light?.dispose();
    this.wire.geometry.dispose();
    this.wireMat.dispose();
    this.sprite.material.dispose();
  }
}

export class LightViews {
  readonly views = new Map<string, LightView>();

  constructor(readonly group: Group) {}

  get(id: string): LightView | undefined {
    return this.views.get(id);
  }

  add(def: LightEntity): LightView {
    this.remove(def.id, false);
    const v = new LightView(def);
    this.views.set(def.id, v);
    this.group.add(v.root);
    this.rebudget();
    return v;
  }

  update(def: LightEntity): void {
    const v = this.views.get(def.id);
    if (!v) {
      this.add(def);
      return;
    }
    v.apply(def);
    this.rebudget();
  }

  remove(id: string, rebudget = true): void {
    const v = this.views.get(id);
    if (!v) return;
    this.group.remove(v.root);
    v.dispose();
    this.views.delete(id);
    if (rebudget) this.rebudget();
  }

  clear(): void {
    for (const id of [...this.views.keys()]) this.remove(id, false);
  }

  setSelected(ids: Set<string>): void {
    for (const v of this.views.values()) {
      const s = ids.has(v.def.id);
      if (s !== v.selected) {
        v.selected = s;
        v.refreshState();
      }
    }
  }

  /** The first few enabled lights are real lights, the first few of those cast shadows; the rest only show their helper. */
  private rebudget(): void {
    let real = 0;
    let shadows = 0;
    for (const v of this.views.values()) {
      const emitting = v.def.enabled && !v.def.hidden;
      v.overBudget = emitting && real >= MAX_REAL_LIGHTS;
      if (emitting && !v.overBudget) real++;
      v.shadowAllowed = true;
      if (emitting && !v.overBudget && v.def.castShadow && v.def.lightType !== 'area') {
        v.shadowAllowed = shadows < MAX_SHADOW_LIGHTS;
        if (v.shadowAllowed) shadows++;
      }
      v.refreshState();
    }
  }

  /** How many enabled lights exceed the render budget (the editor tells the user). */
  get overBudgetCount(): number {
    let n = 0;
    for (const v of this.views.values()) if (v.overBudget) n++;
    return n;
  }

  /** Click targets: the icon sprites of visible lights. */
  pickables(): Object3D[] {
    const out: Object3D[] = [];
    for (const v of this.views.values()) if (!v.def.hidden) out.push(v.sprite);
    return out;
  }

  /** Colour of a light for swatches. */
  static swatch(def: LightEntity): string {
    return new Color(def.color).getStyle();
  }
}
