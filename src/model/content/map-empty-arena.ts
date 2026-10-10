/**
 * Map "Empty arena" — a 24 × 24 m concrete-walled floor with nothing in it: the cleanest place to build a
 * machine, run an experiment or test a vehicle. The walls are 3 m high and 0.6 m thick, so a fast projectile is
 * kept in.
 */
import { Builder } from '../builder';
import { addWalls, topDownThumbnail } from '../mapKit';
import type { SceneDocument } from '../types';
import { registerMap } from './registry';

/** Half the side of the enclosed floor, metres. */
const HALF = 12;

function build(): SceneDocument {
  const b = new Builder('Empty arena');
  // The floor ends exactly at the walls, so nothing can roll out underneath them.
  b.doc.settings.ground.halfSize = HALF;
  addWalls(b, { halfX: HALF, halfZ: HALF, height: 3, thickness: 0.6, material: 'concrete' });
  return b.done();
}

registerMap({
  id: 'empty-arena',
  name: 'Empty arena',
  description: 'A 24 × 24 m walled floor with nothing on it. Build a machine, run an experiment, test a vehicle.',
  category: 'Arenas',
  difficulty: 'sandbox',
  tags: ['empty', 'flat', 'walled'],
  objective: 'Free play: there is nothing to win here. Add shapes, build something, then press Simulate.',
  icon: 'layers',
  thumbnail: () => topDownThumbnail(build()),
  spawn: { position: [0, 0.5, 0], yaw: 0 },
  camera: { position: [0, 17, 22], target: [0, 0, 0] },
  build,
});
