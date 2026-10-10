/**
 * The built-in shapes, in palette order (the first nine also answer to the 1–9 keys).
 * To add one: create `<id>.ts` next to these files exporting a `ShapeDef` and add it to the array below.
 */
import type { ShapeDef } from '../shapeRegistry';
import { box } from './box';
import { capsule } from './capsule';
import { chunk } from './chunk'; // -- ED-B: cut tool pieces --
import { cone } from './cone';
import { cylinder } from './cylinder';
import { icosahedron } from './icosahedron';
import { prism } from './prism';
import { sphere } from './sphere';
import { wedge } from './wedge';

export const BUILTIN_SHAPES: readonly ShapeDef[] = [
  box,
  sphere,
  cylinder,
  capsule,
  cone,
  wedge,
  prism,
  icosahedron,
  chunk,
];
