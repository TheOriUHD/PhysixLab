/**
 * Surface finish of shapes beyond a flat colour:
 *  - vertex colours: a geometry with a `color` attribute (the tyre of the wheel is darker than its rim) is drawn
 *    with it, multiplied by the body's colour;
 *  - painted surfaces (`ShapeDef.surface`): a texture produced by a painter registered here (the pips and numbers of
 *    the dice) over the geometry's uvs. The texture is an ink mask: black = the body, white = ink. The material mixes
 *    the ink into the body's colour — dark ink on a light body, light ink on a dark one — so a die of any colour
 *    stays readable, and the colour modes (speed, energy …) still tint it.
 *
 * Textures are painted once per variant and shared by every body and thumbnail that uses them.
 */
import type { BufferGeometry, MeshStandardMaterial, Texture } from 'three';
import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, NoColorSpace } from 'three';
import { shapeDef } from '../model/shapeRegistry';
import type { DieKind } from '../model/shapes/diceLayout';
import type { ShapeSpec } from '../model/types';
import { paintDiceAtlas } from './dicePainter';

type Painter = (variant: string) => HTMLCanvasElement;

/** The painters a `ShapeDef.surface.painter` can name. */
const PAINTERS: Record<string, Painter> = {
  dice: (variant) => paintDiceAtlas(variant as DieKind),
};

const textures = new Map<string, Texture>();

/** The ink-mask texture of a shape, or null when it has no painted surface (or no canvas is available). */
export function surfaceTexture(spec: ShapeSpec): Texture | null {
  const surface = shapeDef(spec.type).surface;
  if (!surface) return null;
  const paint = PAINTERS[surface.painter];
  if (!paint || typeof document === 'undefined') return null;
  const variant = surface.variant ? surface.variant(spec) : '';
  const key = `${surface.painter}|${variant}`;
  let tex = textures.get(key);
  if (!tex) {
    tex = new CanvasTexture(paint(variant));
    tex.colorSpace = NoColorSpace; // an ink mask, not a colour
    tex.generateMipmaps = true;
    tex.minFilter = LinearMipmapLinearFilter;
    tex.magFilter = LinearFilter;
    tex.anisotropy = 8;
    textures.set(key, tex);
  }
  return tex;
}

const INK_KEY = 'shape-ink-mask';

/** Darkest and lightest ink, linear. */
const INK_DARK = 'vec3( 0.012 )';
const INK_LIGHT = 'vec3( 0.86 )';

/** Mix the ink mask (red channel of the map) into the diffuse colour instead of multiplying the two. */
function inkShader(material: MeshStandardMaterial): void {
  material.onBeforeCompile = (shader, renderer) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#ifdef USE_MAP
        float inkMask = texture2D( map, vMapUv ).r;
        float bodyLum = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
        vec3 inkColor = bodyLum > 0.22 ? ${INK_DARK} : ${INK_LIGHT};
        diffuseColor.rgb = mix( diffuseColor.rgb, inkColor, inkMask );
      #endif`,
    );
    damageHook(material)?.call(material, shader, renderer);
  };
  material.customProgramCacheKey = () => INK_KEY + (damageKey(material) ? `|${damageKey(material)}` : '');
}

type Hook = MeshStandardMaterial['onBeforeCompile'];
const damageKey = (m: MeshStandardMaterial): string => (m.userData as { damageKey?: string }).damageKey ?? '';
const damageHook = (m: MeshStandardMaterial): Hook | undefined => (m.userData as { damageHook?: Hook }).damageHook;

/**
 * Set the material up for the geometry and shape it draws: vertex colours when the geometry carries them, the
 * painted surface when the shape has one. Safe to call again after the shape (and so the geometry) changed.
 */
export function applyShapeSurface(material: MeshStandardMaterial, geo: BufferGeometry, spec: ShapeSpec): void {
  const vertexColors = geo.hasAttribute('color');
  const map = surfaceTexture(spec);
  const changed = material.vertexColors !== vertexColors || (material.map ?? null) !== map;
  material.vertexColors = vertexColors;
  material.map = map;
  if (map) inkShader(material);
  else {
    // Keep the damage look (VZ-41) when the material has it; otherwise no patch at all.
    material.onBeforeCompile = damageHook(material) ?? (() => undefined);
    material.customProgramCacheKey = () => damageKey(material);
  }
  if (changed) material.needsUpdate = true;
}

/** Free the painted textures (the viewport being torn down). */
export function disposeSurfaceTextures(): void {
  for (const t of textures.values()) t.dispose();
  textures.clear();
}
