/**
 * Map "Sandbox box" — a 10 × 10 m wooden box with a mound of 104 loose, sand-coloured blocks and two toys.
 * The walls are 1 m high and 0.4 m thick; the blocks are small and rough enough to pile up, slide and topple
 * the way a heap of something granular does (they are rigid cubes — see docs/LIMITATIONS.md on granular media).
 */
import { Builder } from '../builder';
import { addWalls, topDownThumbnail } from '../mapKit';
import type { SceneDocument } from '../types';
import { registerMap } from './registry';

const HALF = 5;
/** Edge of one sand block and the grid it is laid on, metres (a hair of clearance so nothing starts overlapped). */
const CELL = 0.25;
const BLOCK = CELL - 0.004;
/** Centre of the mound in z: towards the back wall, leaving the front of the box free. */
const MOUND_Z = -1.5;

const SAND = { preset: 'concrete', density: 700, friction: 0.9, restitution: 0.02, color: '#d9b86c' };

function build(): SceneDocument {
  const b = new Builder('Sandbox box');
  b.doc.settings.ground.halfSize = HALF;
  b.doc.settings.ground.friction = 0.9;
  addWalls(b, { halfX: HALF, halfZ: HALF, height: 1, thickness: 0.4, material: 'wood' });

  // A stepped mound: every layer is inset by one block on each side of the one below, so it is stable at rest.
  let n = 0;
  for (let layer = 0, nx = 10, nz = 6; nx > 0 && nz > 0; layer++, nx -= 2, nz -= 2) {
    for (let i = 0; i < nx; i++)
      for (let j = 0; j < nz; j++) {
        b.body(
          `Sand block ${++n}`,
          'box',
          [BLOCK, BLOCK, BLOCK],
          [(i - (nx - 1) / 2) * CELL, CELL / 2 + layer * CELL, MOUND_Z + (j - (nz - 1) / 2) * CELL],
          { material: SAND },
        );
      }
  }

  b.body('Beach ball', 'sphere', [0.8, 0.8, 0.8], [2.6, 0.4, 2.4], {
    material: { preset: 'rubber', color: '#ff6b81' },
  });
  b.body('Toy crate', 'box', [0.6, 0.6, 0.6], [-2.4, 0.3, 2.6], { material: 'wood' });
  return b.done();
}

registerMap({
  id: 'sandbox-box',
  name: 'Sandbox box',
  description: 'A wooden box with a mound of loose sand-coloured blocks, a beach ball and a toy crate to play with.',
  category: 'Arenas',
  difficulty: 'sandbox',
  tags: ['sandbox', 'blocks', 'toys'],
  objective: 'Free play: pile, push and knock things over. Roll something heavy into the mound.',
  icon: 'box',
  thumbnail: () => topDownThumbnail(build()),
  spawn: { position: [0, 0.5, 3], yaw: 0 },
  camera: { position: [0, 8.5, 10], target: [0, 0.4, 0] },
  build,
});
