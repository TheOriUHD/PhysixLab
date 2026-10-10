/**
 * Search words for the shapes that predate `ShapeDef.keywords`, so "ball" finds the sphere, "donut" the torus and
 * "girder" the beams. A shape's own `keywords` are added to these (`shapeKeywords`).
 */
import type { ShapeDef } from '../shapeRegistry';

export const LEGACY_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  box: ['cube', 'block', 'brick', 'crate', 'rectangle', 'cuboid', 'slab', 'wall', 'floor', 'platform'],
  sphere: ['ball', 'globe', 'orb', 'marble', 'round', 'planet'],
  cylinder: ['can', 'tube', 'pipe', 'rod', 'barrel', 'drum', 'pillar', 'column', 'log', 'roller'],
  capsule: ['pill', 'stadium', 'bean', 'rounded'],
  cone: ['spike', 'traffic', 'cap', 'funnel', 'party hat'],
  wedge: ['ramp', 'slope', 'incline', 'door stop', 'doorstop', 'triangle', 'slide'],
  prism: ['polygon', 'hexagon', 'pentagon', 'octagon', 'column', 'nut'],
  icosahedron: ['d20', 'twenty', 'platonic', 'geodesic', 'gem'],
  torus: ['donut', 'doughnut', 'ring', 'tire', 'tyre', 'inner tube', 'bagel', 'o-ring'],
  ring: ['washer', 'annulus', 'hoop', 'band', 'flat ring', 'gasket'],
  tube: ['pipe', 'hollow', 'sleeve', 'bushing', 'duct', 'barrel'],
  arch: ['bridge', 'gate', 'doorway', 'tunnel', 'vault', 'arc', 'curve'],
  stairs: ['steps', 'staircase', 'ladder', 'stair', 'climb'],
  'spiral-stairs': ['helix', 'staircase', 'winding', 'tower', 'steps', 'climb', 'turret'],
  hemisphere: ['half sphere', 'bowl', 'dome', 'cup', 'bubble'],
  dome: ['cap', 'bowl', 'igloo', 'roof', 'shell', 'cupola'],
  frustum: ['truncated', 'bucket', 'cup', 'lampshade', 'pot', 'tapered', 'cone'],
  'i-beam': ['girder', 'beam', 'joist', 'steel', 'rail', 'h-beam', 'rsj'],
  'l-beam': ['angle', 'bracket', 'corner', 'girder', 'beam', 'steel'],
  't-beam': ['girder', 'beam', 'steel', 'tee', 'joist'],
};

/** Every search word of a shape: its own and the ones listed here. */
export function shapeKeywords(def: Pick<ShapeDef, 'id' | 'keywords'>): readonly string[] {
  const own = def.keywords ?? [];
  const extra = LEGACY_KEYWORDS[def.id] ?? [];
  return extra.length ? [...own, ...extra] : own;
}
