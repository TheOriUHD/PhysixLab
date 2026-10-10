/** Sanitising of the optional PBR extras and texture spec of a `MaterialSpec` (VZ-1..VZ-4). */
import { clamp } from '../../core/math';
import type { MaterialSpec, ProceduralPattern, TextureSpec } from '../types';
import { bool, hexColor, idStr, isFiniteVec, num, obj, oneOf } from './primitives';

export const PATTERNS: readonly ProceduralPattern[] = [
  'checker',
  'stripes',
  'hazard',
  'wood',
  'brick',
  'concrete',
  'marble',
  'noise',
  'grid',
  'dots',
  'carbon',
];

const opt = (raw: Record<string, unknown>, key: string, lo: number, hi: number): number | undefined => {
  const v = raw[key];
  return typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : undefined;
};

function pair(x: unknown, d: [number, number], lo: number, hi: number): [number, number] {
  if (isFiniteVec(x, 2)) return [clamp(x[0], lo, hi), clamp(x[1], lo, hi)];
  return [...d];
}

export function defaultTextureSpec(pattern: TextureSpec['pattern'] = 'checker'): TextureSpec {
  return {
    pattern,
    color2: '#ffffff',
    scale: [1, 1],
    rotation: 0,
    offset: [0, 0],
    triplanar: false,
    bump: 0,
    normalStrength: 1,
  };
}

export function sanitizeTexture(raw: unknown): TextureSpec | undefined {
  const r = obj(raw);
  if (!Object.keys(r).length) return undefined;
  const d = defaultTextureSpec();
  const pattern = oneOf<TextureSpec['pattern']>(r.pattern, [...PATTERNS, 'image'], 'checker');
  const t: TextureSpec = {
    pattern,
    color2: hexColor(r.color2, d.color2),
    scale: pair(r.scale, d.scale, 0.01, 200),
    rotation: clamp(num(r.rotation, 0), -360, 360),
    offset: pair(r.offset, d.offset, -100, 100),
    triplanar: bool(r.triplanar, false),
    bump: clamp(num(r.bump, 0), 0, 4),
    normalStrength: clamp(num(r.normalStrength, 1), 0, 4),
  };
  for (const k of ['imageId', 'normalId', 'roughnessId', 'emissiveId'] as const) {
    if (typeof r[k] === 'string' && r[k]) t[k] = idStr(r[k], '');
  }
  // an image pattern without an image is a dangling texture: drop it
  if (t.pattern === 'image' && !t.imageId) return undefined;
  return t;
}

/** The optional visual fields of a raw material, ready to spread over the sanitised base fields. */
export function sanitizeVisual(raw: unknown): Partial<MaterialSpec> {
  const m = obj(raw);
  const out: Partial<MaterialSpec> = {};
  const emissive = hexColor(m.emissive, '');
  if (emissive) out.emissive = emissive;
  const set = <
    K extends
      | 'emissiveIntensity'
      | 'clearcoat'
      | 'clearcoatRoughness'
      | 'transmission'
      | 'ior'
      | 'thickness'
      | 'sheen'
      | 'anisotropy',
  >(
    k: K,
    lo: number,
    hi: number,
  ) => {
    const v = opt(m, k, lo, hi);
    if (v !== undefined) out[k] = v;
  };
  set('emissiveIntensity', 0, 50);
  set('clearcoat', 0, 1);
  set('clearcoatRoughness', 0, 1);
  set('transmission', 0, 1);
  set('ior', 1, 2.333);
  set('thickness', 0, 10);
  set('sheen', 0, 1);
  set('anisotropy', 0, 1);
  const sheenColor = hexColor(m.sheenColor, '');
  if (sheenColor) out.sheenColor = sheenColor;
  const texture = sanitizeTexture(m.texture);
  if (texture) out.texture = texture;
  return out;
}
