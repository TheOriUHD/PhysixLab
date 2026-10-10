// File: src/model/content/map-step-court.ts
import { Builder } from '../../src/model/builder';
import { registerMap } from '../../src/model/content';
import { addWalls, topDownThumbnail } from '../../src/model/mapKit';

function build() {
  const b = new Builder('Step court');
  b.doc.settings.ground.halfSize = 8;
  addWalls(b, { halfX: 8, halfZ: 8, height: 2, thickness: 0.5, material: 'concrete' });
  // Three tiers of a step pyramid in the middle of the court.
  [4, 2.5, 1].forEach((side, tier) =>
    b.body(`Tier ${tier + 1}`, 'box', [side, 0.4, side], [0, 0.2 + tier * 0.4, 0], {
      bodyType: 'static',
      material: 'concrete',
    }),
  );
  return b.done();
}

registerMap({
  id: 'step-court',
  name: 'Step court',
  description: 'A walled court with a three-tier step pyramid in the middle.',
  category: 'Arenas',
  difficulty: 'easy',
  tags: ['steps', 'climb'],
  objective: 'Get something to rest on the top tier.',
  thumbnail: () => topDownThumbnail(build()),
  spawn: { position: [0, 0.5, 6], yaw: 0 },
  camera: { position: [0, 11, 14], target: [0, 0, 0] },
  build,
});
