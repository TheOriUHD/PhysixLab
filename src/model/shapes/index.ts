/**
 * The built-in shapes, in palette order (the first nine also answer to the 1–9 keys).
 * To add one: create `<id>.ts` next to these files exporting a `ShapeDef` and add it to the array below.
 */
import type { ShapeDef } from '../shapeRegistry';
import { box } from './box';
import { capsule } from './capsule';
import { cone } from './cone';
import { cylinder } from './cylinder';
import { icosahedron } from './icosahedron';
import { prism } from './prism';
import { sphere } from './sphere';
import { wedge } from './wedge';
// -- SH: primitive shapes I (torus, ring, tube, arch, stairs, spiral stairs, hemisphere, dome, frustum, beams) --
import { arch } from './arch';
import { dome } from './dome';
import { frustum } from './frustum';
import { hemisphere } from './hemisphere';
import { iBeam } from './iBeam';
import { lBeam } from './lBeam';
import { ring } from './ring';
import { spiralStairs } from './spiralStairs';
import { stairs } from './stairs';
import { tBeam } from './tBeam';
import { torus } from './torus';
import { tube } from './tube';
// -- SH: primitive shapes II (ellipsoid, regular solids) --
import { ellipsoid } from './ellipsoid';
import { pyramid, tetrahedron } from './pyramid';
import { dodecahedron, octahedron } from './platonicShapes';
import { curvedRamp, quarterPipe } from './curvedRamp';
import { halfPipe } from './halfPipe';
import { roundedBox } from './roundedBox';
import { roundedCylinder } from './roundedCylinder';

export const BUILTIN_SHAPES: readonly ShapeDef[] = [
  box,
  sphere,
  cylinder,
  capsule,
  cone,
  wedge,
  prism,
  icosahedron,
  // -- SH: primitive shapes I --
  torus,
  ring,
  tube,
  arch,
  stairs,
  spiralStairs,
  hemisphere,
  dome,
  frustum,
  iBeam,
  lBeam,
  tBeam,
  // -- SH: primitive shapes II --
  ellipsoid,
  pyramid,
  tetrahedron,
  octahedron,
  dodecahedron,
  roundedBox,
  roundedCylinder,
  curvedRamp,
  quarterPipe,
  halfPipe,
];
