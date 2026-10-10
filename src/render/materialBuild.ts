/**
 * Turns a document `MaterialSpec` into a three.js `MeshPhysicalMaterial` (VZ-1..VZ-4): PBR values, clearcoat /
 * transmission / sheen / anisotropy, procedural or user textures with UV transform, derived normal maps and the
 * optional triplanar projection. Textures are cached by content; every material owns cheap clones of them (so each
 * body keeps its own UV transform) which it disposes when they change.
 */
import {
  CanvasTexture,
  LinearSRGBColorSpace,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import type { MeshPhysicalMaterial } from 'three';
import type { MaterialSpec, TextureAsset, TextureSpec } from '../model/types';
import { heightToNormal, renderPattern } from './proceduralTextures';

/** What the material builder needs from the application. Wired once by the App; defaults keep tests/preview working. */
export const materialContext = {
  /** Look an asset up by id. */
  asset: (_id: string): TextureAsset | undefined => undefined,
  /** Real light transmission (an extra scene pass): switched off by the low-quality tier. */
  transmission: true,
  /** Called when an async image finishes loading so the viewport redraws. */
  invalidate: (): void => undefined,
};

const PATTERN_SIZE = 256;
const baseCache = new Map<string, Texture>();
const imageCache = new Map<string, Texture>();

export function canvasTextureFromRgba(data: Uint8ClampedArray, size: number, colorSpace: string): CanvasTexture {
  return canvasTexture(data, size, colorSpace);
}

function canvasTexture(data: Uint8ClampedArray, size: number, colorSpace: string): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.putImageData(new ImageData(new Uint8ClampedArray(data), size, size), 0, 0);
  const tex = new CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.colorSpace = colorSpace;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  return tex;
}

/** Cached colour + normal base textures of a procedural pattern. */
function patternTextures(t: TextureSpec, base: string): { color: Texture; normal: Texture | null } {
  const key = `${t.pattern}|${base}|${t.color2}`;
  let color = baseCache.get(key);
  let normal = baseCache.get(`${key}|n${t.bump.toFixed(2)}`) ?? null;
  if (!color || (t.bump > 0 && !normal)) {
    const buf = renderPattern(t.pattern as never, base, t.color2, PATTERN_SIZE);
    if (!color) {
      color = canvasTexture(buf.color, PATTERN_SIZE, SRGBColorSpace);
      baseCache.set(key, color);
    }
    if (t.bump > 0 && !normal) {
      normal = canvasTexture(heightToNormal(buf.height, PATTERN_SIZE, t.bump * 4), PATTERN_SIZE, LinearSRGBColorSpace);
      baseCache.set(`${key}|n${t.bump.toFixed(2)}`, normal);
    }
  }
  return { color, normal: t.bump > 0 ? normal : null };
}

/** A user-supplied image as a texture (loaded asynchronously from the asset's data URL). */
function imageTexture(id: string, colorSpace: string): Texture | null {
  const asset = materialContext.asset(id);
  if (!asset) return null;
  const key = `${asset.id}:${asset.hash}:${colorSpace}`;
  let tex = imageCache.get(key);
  if (!tex) {
    tex = new Texture();
    tex.wrapS = tex.wrapT = RepeatWrapping;
    tex.colorSpace = colorSpace;
    tex.anisotropy = 4;
    const img = new Image();
    const target = tex;
    img.onload = () => {
      target.image = img;
      target.needsUpdate = true;
      materialContext.invalidate();
    };
    img.src = asset.dataUrl;
    imageCache.set(key, tex);
  }
  return tex;
}

/** A per-material clone carrying the spec's UV transform. */
function withUv(base: Texture, t: TextureSpec): Texture {
  const c = base.clone();
  c.needsUpdate = true;
  c.repeat.set(t.scale[0], t.scale[1]);
  c.center.set(0.5, 0.5);
  c.rotation = (t.rotation * Math.PI) / 180;
  c.offset.set(t.offset[0], t.offset[1]);
  return c;
}

interface MatState {
  texKey: string;
  owned: Texture[];
  triplanar: boolean;
}

const states = new WeakMap<MeshPhysicalMaterial, MatState>();

function stateOf(m: MeshPhysicalMaterial): MatState {
  let s = states.get(m);
  if (!s) {
    s = { texKey: '', owned: [], triplanar: false };
    states.set(m, s);
  }
  return s;
}

/** Free the texture clones a material owns (call before disposing the material). */
export function disposeMaterialTextures(m: MeshPhysicalMaterial): void {
  const s = states.get(m);
  if (!s) return;
  for (const t of s.owned) t.dispose();
  s.owned = [];
  s.texKey = '';
}

/** Per-vertex object-space position and normal for the triplanar projection. */
function patchTriplanar(shader: WebGLProgramParametersWithUniforms): void {
  // The UV transform (`mapTransform`) only exists in the vertex shader, so the three projected coordinate pairs are
  // transformed there and handed to the fragment shader as varyings.
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      '#include <common>\nvarying vec3 vTriN;\nvarying vec2 vTriX;\nvarying vec2 vTriY;\nvarying vec2 vTriZ;',
    )
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
vec3 triPos = position * vec3(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz), length(modelMatrix[2].xyz));
vTriN = normal;
#ifdef USE_MAP
vTriX = ( mapTransform * vec3( triPos.zy, 1.0 ) ).xy;
vTriY = ( mapTransform * vec3( triPos.xz, 1.0 ) ).xy;
vTriZ = ( mapTransform * vec3( triPos.xy, 1.0 ) ).xy;
#else
vTriX = vTriY = vTriZ = vec2( 0.0 );
#endif`,
    );
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      '#include <common>\nvarying vec3 vTriN;\nvarying vec2 vTriX;\nvarying vec2 vTriY;\nvarying vec2 vTriZ;',
    )
    .replace(
      '#include <map_fragment>',
      `#ifdef USE_MAP
  vec3 triW = pow(abs(normalize(vTriN)), vec3(4.0));
  triW /= (triW.x + triW.y + triW.z);
  vec3 triC = texture2D(map, vTriX).rgb * triW.x + texture2D(map, vTriY).rgb * triW.y + texture2D(map, vTriZ).rgb * triW.z;
  diffuseColor *= vec4(triC, 1.0);
#endif`,
    );
}

/**
 * Bring `mat` in line with `spec`. `ghostly` caps the opacity (ghost bodies / sensor parts). Flags the material for
 * recompilation itself when a feature (texture, triplanar …) appears or goes away.
 */
export function applyMaterialSpec(mat: MeshPhysicalMaterial, spec: MaterialSpec, ghostly = false): void {
  const st = stateOf(mat);
  mat.color.set(spec.color);
  mat.metalness = spec.metalness;
  mat.roughness = spec.roughness;
  mat.envMapIntensity = 1;

  const emissiveOn = !!spec.emissive && (spec.emissiveIntensity ?? 1) > 0;
  mat.emissive.set(emissiveOn ? spec.emissive! : '#000000');
  mat.emissiveIntensity = emissiveOn ? (spec.emissiveIntensity ?? 1) : 1;

  const clearcoat = spec.clearcoat ?? 0;
  mat.clearcoat = clearcoat;
  mat.clearcoatRoughness = spec.clearcoatRoughness ?? 0.1;
  const sheen = spec.sheen ?? 0;
  mat.sheen = sheen;
  mat.sheenRoughness = 0.5;
  mat.sheenColor.set(spec.sheenColor ?? '#ffffff');
  mat.anisotropy = spec.anisotropy ?? 0;
  mat.ior = spec.ior ?? 1.5;

  const trans = materialContext.transmission ? (spec.transmission ?? 0) : 0;
  mat.transmission = trans;
  mat.thickness = spec.thickness ?? 0;
  if (trans > 0) {
    // transmission replaces alpha blending: the opacity slider is ignored while it is on
    mat.opacity = 1;
    mat.transparent = false;
  } else {
    mat.opacity = ghostly ? Math.min(spec.opacity, 0.35) : spec.opacity;
    mat.transparent = mat.opacity < 0.999;
  }
  mat.depthWrite = true;

  // ---- textures -------------------------------------------------------------------------------
  const t = spec.texture;
  const assetKey = t
    ? [t.imageId, t.normalId, t.roughnessId, t.emissiveId]
        .map((id) => materialContext.asset(id ?? '')?.hash ?? '')
        .join(',')
    : '';
  const key = t ? JSON.stringify([t, assetKey, spec.color]) : '';
  if (key !== st.texKey) {
    for (const o of st.owned) o.dispose();
    st.owned = [];
    st.texKey = key;
    mat.map = mat.normalMap = mat.roughnessMap = mat.emissiveMap = null;
    if (t) {
      const own = (b: Texture | null): Texture | null => {
        if (!b) return null;
        const c = withUv(b, t);
        st.owned.push(c);
        return c;
      };
      let color: Texture | null;
      let normal: Texture | null = null;
      if (t.pattern === 'image') {
        color = t.imageId ? imageTexture(t.imageId, SRGBColorSpace) : null;
      } else {
        const p = patternTextures(t, spec.color);
        color = p.color;
        normal = p.normal;
      }
      if (t.normalId) normal = imageTexture(t.normalId, LinearSRGBColorSpace) ?? normal;
      mat.map = own(color);
      // the pattern already contains the material colour: do not tint it twice
      if (mat.map && t.pattern !== 'image') mat.color.set('#ffffff');
      mat.normalMap = t.triplanar ? null : own(normal);
      mat.roughnessMap = t.roughnessId ? own(imageTexture(t.roughnessId, LinearSRGBColorSpace)) : null;
      mat.emissiveMap = t.emissiveId ? own(imageTexture(t.emissiveId, SRGBColorSpace)) : null;
      if (mat.emissiveMap && !emissiveOn) {
        mat.emissive.set('#ffffff');
        mat.emissiveIntensity = 1;
      }
    }
    mat.needsUpdate = true;
  } else if (mat.map && t && t.pattern !== 'image') {
    mat.color.set('#ffffff');
  }
  if (mat.normalMap && t) mat.normalScale.set(t.normalStrength, t.normalStrength);

  const tri = !!t?.triplanar && !!mat.map;
  if (tri !== st.triplanar) {
    st.triplanar = tri;
    mat.onBeforeCompile = tri ? patchTriplanar : () => undefined;
    mat.customProgramCacheKey = () => (tri ? 'triplanar' : '');
    mat.needsUpdate = true;
  }
}
