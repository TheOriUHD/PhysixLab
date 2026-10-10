import type { MaterialSpec } from './types';

/**
 * Material presets. Densities are real-world values (kg/m³) so mass comes out right when
 * you size objects in metres; friction / restitution are representative surface
 * coefficients, tuned for the engine's pairwise combine rules (friction: average,
 * restitution: max — see docs/ARCHITECTURE.md).
 */
export interface MaterialPreset extends Omit<MaterialSpec, 'preset'> {
  id: string;
  label: string;
  /** Group heading in the material picker. */
  group: MaterialGroup;
}

export type MaterialGroup =
  'Metals' | 'Wood' | 'Stone & masonry' | 'Plastics & rubber' | 'Glass & ceramic' | 'Soft & organic';

export const MATERIAL_GROUPS: MaterialGroup[] = [
  'Metals',
  'Wood',
  'Stone & masonry',
  'Plastics & rubber',
  'Glass & ceramic',
  'Soft & organic',
];

type Extras = Partial<
  Pick<
    MaterialSpec,
    | 'clearcoat'
    | 'clearcoatRoughness'
    | 'transmission'
    | 'ior'
    | 'thickness'
    | 'sheen'
    | 'sheenColor'
    | 'anisotropy'
    | 'texture'
  >
>;

/** Compact preset constructor: density kg/m³, friction, restitution, colour, metalness, roughness, opacity. */
function P(
  group: MaterialGroup,
  id: string,
  label: string,
  density: number,
  friction: number,
  restitution: number,
  color: string,
  metalness: number,
  roughness: number,
  opacity = 1,
  extras: Extras = {},
): MaterialPreset {
  return { id, label, group, density, friction, restitution, color, metalness, roughness, opacity, ...extras };
}

/** Texture shorthand for presets: a procedural pattern in the material colour + `color2`. */
const tex = (
  pattern: NonNullable<MaterialSpec['texture']>['pattern'],
  color2: string,
  scale = 1,
  bump = 0,
): Extras => ({
  texture: {
    pattern,
    color2,
    scale: [scale, scale],
    rotation: 0,
    offset: [0, 0],
    triplanar: false,
    bump,
    normalStrength: 1,
  },
});

export const MATERIAL_PRESETS: MaterialPreset[] = [
  // ---- metals ----
  P('Metals', 'steel', 'Steel', 7850, 0.55, 0.2, '#8e9aa8', 0.9, 0.35),
  P('Metals', 'aluminum', 'Aluminium', 2700, 0.5, 0.25, '#c4cbd3', 0.85, 0.32),
  P('Metals', 'gold', 'Gold', 19300, 0.45, 0.1, '#f0b429', 1, 0.25),
  P('Metals', 'lead', 'Lead', 11340, 0.5, 0.03, '#5c6670', 0.7, 0.55),
  P('Metals', 'brass', 'Brass', 8500, 0.35, 0.2, '#d4a73a', 1, 0.3),
  P('Metals', 'copper', 'Copper', 8960, 0.4, 0.2, '#c8714a', 1, 0.28),
  P('Metals', 'bronze', 'Bronze', 8800, 0.4, 0.2, '#a9743c', 0.95, 0.38),
  P('Metals', 'titanium', 'Titanium', 4500, 0.45, 0.25, '#a9a6a1', 0.95, 0.4),
  P('Metals', 'stainless', 'Stainless steel', 8000, 0.45, 0.22, '#c9ced4', 1, 0.22, 1, { anisotropy: 0.6 }),
  P('Metals', 'castiron', 'Cast iron', 7200, 0.6, 0.12, '#4a4d52', 0.8, 0.6),
  P('Metals', 'silver', 'Silver', 10490, 0.4, 0.15, '#e6e8ea', 1, 0.12),
  P('Metals', 'tungsten', 'Tungsten', 19250, 0.5, 0.1, '#6e7378', 0.9, 0.35),
  // ---- wood ----
  P('Wood', 'wood', 'Wood', 650, 0.5, 0.25, '#b9854f', 0, 0.75),
  P('Wood', 'oak', 'Oak', 750, 0.5, 0.22, '#a9763f', 0, 0.7, 1, tex('wood', '#6d4521', 1.5, 0.6)),
  P('Wood', 'pine', 'Pine', 500, 0.5, 0.25, '#d8b074', 0, 0.75, 1, tex('wood', '#a9783d', 1.5, 0.5)),
  P('Wood', 'bamboo', 'Bamboo', 700, 0.45, 0.22, '#d6c080', 0, 0.55, 1, tex('stripes', '#b59d54', 8, 0.2)),
  P('Wood', 'cardboard', 'Cardboard', 700, 0.6, 0.1, '#b08a5a', 0, 0.95),
  // ---- stone & masonry ----
  P('Stone & masonry', 'concrete', 'Concrete', 2400, 0.75, 0.05, '#9a9a96', 0, 0.95),
  P('Stone & masonry', 'marble', 'Marble', 2700, 0.4, 0.12, '#ece8e2', 0, 0.12, 1, {
    ...tex('marble', '#8a8f99', 1, 0.1),
    clearcoat: 0.4,
  }),
  P('Stone & masonry', 'granite', 'Granite', 2750, 0.55, 0.1, '#7d7a78', 0, 0.45, 1, tex('noise', '#c7c2bd', 6, 0.4)),
  P(
    'Stone & masonry',
    'sandstone',
    'Sandstone',
    2300,
    0.7,
    0.05,
    '#c9a572',
    0,
    0.9,
    1,
    tex('noise', '#a98450', 5, 0.6),
  ),
  P('Stone & masonry', 'brick', 'Brick', 1900, 0.65, 0.08, '#a8503b', 0, 0.9, 1, tex('brick', '#cfc7bb', 2, 0.9)),
  P('Stone & masonry', 'asphalt', 'Asphalt', 2300, 0.85, 0.03, '#35373a', 0, 0.95, 1, tex('noise', '#5a5d62', 10, 0.7)),
  P('Stone & masonry', 'clay', 'Clay', 1700, 0.8, 0.02, '#b8744f', 0, 0.9),
  // ---- plastics & rubber ----
  P('Plastics & rubber', 'rubber', 'Rubber', 1100, 1.0, 0.85, '#e0584c', 0, 0.85),
  P('Plastics & rubber', 'plastic', 'Plastic', 1200, 0.35, 0.4, '#3d8bff', 0, 0.4),
  P('Plastics & rubber', 'neoprene', 'Neoprene', 1230, 0.9, 0.55, '#26292e', 0, 0.9),
  P('Plastics & rubber', 'ptfe', 'PTFE (Teflon)', 2200, 0.05, 0.3, '#f4f4f0', 0, 0.35),
  P('Plastics & rubber', 'acrylic', 'Acrylic', 1180, 0.4, 0.35, '#cfe8f5', 0, 0.05, 0.55, {
    transmission: 0.85,
    ior: 1.49,
    thickness: 0.4,
  }),
  P('Plastics & rubber', 'silicone', 'Silicone', 1100, 0.85, 0.6, '#9ee0c8', 0, 0.45, 0.9, {
    sheen: 0.4,
    sheenColor: '#ffffff',
  }),
  P('Plastics & rubber', 'carbon', 'Carbon fibre', 1600, 0.4, 0.2, '#1c1d20', 0.1, 0.3, 1, {
    ...tex('carbon', '#3a3c42', 6, 0.5),
    clearcoat: 1,
    clearcoatRoughness: 0.05,
  }),
  P('Plastics & rubber', 'bubblewrap', 'Bubble wrap', 30, 0.6, 0.35, '#dfeff8', 0, 0.15, 0.55, {
    ...tex('dots', '#ffffff', 10, 1.2),
    transmission: 0.5,
    ior: 1.45,
    thickness: 0.05,
  }),
  // ---- glass & ceramic ----
  P('Glass & ceramic', 'glass', 'Glass', 2500, 0.35, 0.3, '#9fd8e8', 0, 0.05, 0.45, {
    transmission: 0.9,
    ior: 1.5,
    thickness: 0.5,
  }),
  P('Glass & ceramic', 'ice', 'Ice', 920, 0.03, 0.08, '#bfe6ff', 0, 0.12, 0.8, {
    transmission: 0.6,
    ior: 1.31,
    thickness: 0.6,
  }),
  P('Glass & ceramic', 'ceramic', 'Ceramic', 2300, 0.45, 0.18, '#efe9de', 0, 0.2, 1, {
    clearcoat: 0.6,
    clearcoatRoughness: 0.1,
  }),
  // ---- soft & organic ----
  P('Soft & organic', 'foam', 'Foam', 60, 0.7, 0.15, '#f3c94e', 0, 0.9),
  P('Soft & organic', 'leather', 'Leather', 950, 0.7, 0.2, '#6b3f2a', 0, 0.55, 1, {
    ...tex('noise', '#4e2b1b', 14, 0.9),
    sheen: 0.3,
    sheenColor: '#b98a6c',
  }),
  P('Soft & organic', 'cloth', 'Cloth', 300, 0.8, 0.05, '#5c7fb0', 0, 0.95, 1, {
    ...tex('grid', '#4a6a96', 40, 0.5),
    sheen: 1,
    sheenColor: '#9fb8dc',
  }),
  P('Soft & organic', 'bone', 'Bone', 1900, 0.5, 0.15, '#e9e1cf', 0, 0.6),
  P('Soft & organic', 'chocolate', 'Chocolate', 1300, 0.55, 0.05, '#4b2a1a', 0, 0.35, 1, { clearcoat: 0.3 }),
];

export const PRESET_BY_ID = new Map(MATERIAL_PRESETS.map((p) => [p.id, p]));

export function materialFromPreset(id: string, overrides: Partial<MaterialSpec> = {}): MaterialSpec {
  const p = PRESET_BY_ID.get(id) ?? PRESET_BY_ID.get('plastic')!;
  return {
    preset: p.id,
    density: p.density,
    friction: p.friction,
    restitution: p.restitution,
    color: p.color,
    metalness: p.metalness,
    roughness: p.roughness,
    opacity: p.opacity,
    ...presetExtras(p),
    ...overrides,
  };
}

/** The optional PBR extras / texture of a preset (empty for the plain ones). */
export function presetExtras(p: MaterialPreset): Partial<MaterialSpec> {
  const out: Partial<MaterialSpec> = {};
  for (const k of [
    'clearcoat',
    'clearcoatRoughness',
    'transmission',
    'ior',
    'thickness',
    'sheen',
    'sheenColor',
    'anisotropy',
  ] as const) {
    if (p[k] !== undefined) (out as Record<string, unknown>)[k] = p[k];
  }
  if (p.texture) out.texture = { ...p.texture, scale: [...p.texture.scale], offset: [...p.texture.offset] };
  return out;
}

/** A complete `MaterialSpec` of a preset. */
export function specOfPreset(p: MaterialPreset): MaterialSpec {
  return materialFromPreset(p.id);
}
