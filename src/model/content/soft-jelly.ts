/**
 * Jelly shapes (SF-5): volumetric soft meshes built from the shape registry's convex shapes, dropped onto the ground.
 * The registry has no gear or dice shape, so the cast is the shapes that exist: sphere, cylinder, box, icosahedron,
 * cone, capsule and wedge.
 */
import type { ShapeSpec } from '../types';
import { Builder } from '../builder';
import { registerTemplate } from './registry';

export interface JellyKind {
  name: string;
  shape: ShapeSpec;
  color: string;
}

export const JELLY_KINDS: JellyKind[] = [
  { name: 'Sphere jelly', shape: { type: 'sphere', size: [1, 1, 1] }, color: '#ff6fae' },
  { name: 'Cylinder jelly', shape: { type: 'cylinder', size: [0.9, 1, 0.9] }, color: '#7be0a0' },
  { name: 'Box jelly', shape: { type: 'box', size: [0.9, 0.9, 0.9] }, color: '#6fb7ff' },
  { name: 'Icosahedron jelly', shape: { type: 'icosahedron', size: [1, 1, 1] }, color: '#ffd166' },
  { name: 'Cone jelly', shape: { type: 'cone', size: [0.95, 1.1, 0.95] }, color: '#c792ea' },
  { name: 'Capsule jelly', shape: { type: 'capsule', size: [0.7, 1.3, 0.7] }, color: '#ff9d4d' },
];

export function buildJellyShapes(): Builder {
  const b = new Builder('Jelly shapes');
  const gap = 1.5;
  JELLY_KINDS.forEach((k, i) => {
    const x = (i - (JELLY_KINDS.length - 1) / 2) * gap;
    b.soft(k.name, 'mesh', [x, 1.6 + (i % 3) * 0.5, (i % 2) * 0.4 - 0.2], {
      shape: k.shape,
      size: k.shape.size,
      cell: 0.3,
      mass: 5,
      stiffness: 10,
      damping: 0.2,
      color: k.color,
      friction: 0.8,
    });
  });
  return b;
}

registerTemplate({
  id: 'jelly-shapes',
  name: 'Jelly shapes',
  category: 'Soft bodies',
  blurb: 'Volumetric jellies of six shapes — sphere, cylinder, box, icosahedron, cone and capsule — land and wobble.',
  hint: 'Press Play: each jelly squashes on landing and springs back. Drag one with the mouse, or change its stiffness.',
  view: { position: [0, 3.2, 9], target: [0, 0.8, 0] },
  build: () => buildJellyShapes().done(),
});
