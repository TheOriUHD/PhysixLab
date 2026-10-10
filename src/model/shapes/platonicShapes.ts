/** Octahedron (a diamond, standing on a vertex) and dodecahedron (twelve pentagons, standing on a face). */
import type { ShapeDef } from '../shapeRegistry';
import { convexSolid } from './convexSolid';
import { dodecahedronFaceUp, octahedronVertexUp } from './platonic';
import { SHAPE_ICONS } from './shapeIcons';

export const octahedron: ShapeDef = convexSolid({
  id: 'octahedron',
  label: 'Octahedron',
  icon: SHAPE_ICONS.octahedron,
  category: 'solids',
  blurb: 'Regular eight-faced diamond: it balances on a vertex until nudged',
  keywords: ['d8', 'diamond', 'gem', 'platonic', 'eight'],
  unitPoints: octahedronVertexUp,
});

export const dodecahedron: ShapeDef = convexSolid({
  id: 'dodecahedron',
  label: 'Dodecahedron',
  icon: SHAPE_ICONS.dodecahedron,
  category: 'solids',
  blurb: 'Regular twelve-faced solid of pentagons: a near-round rolling body',
  keywords: ['d12', 'pentagon', 'platonic', 'twelve'],
  unitPoints: dodecahedronFaceUp,
});
