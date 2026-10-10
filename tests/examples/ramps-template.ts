// File: src/model/content/three-ramps.ts   (files in src/model/content are collected automatically)
import type { Vec3 } from '../../src/core/math';
import { Builder, rotX } from '../../src/model/builder';
import { registerTemplate } from '../../src/model/content';

const ANGLE = 30; // degrees: steeper than wood's friction angle (about 27°), shallower than rubber's (45°)

registerTemplate({
  id: 'three-ramps',
  name: 'Three ramps',
  category: 'Physics labs',
  blurb: 'A block on three 30° ramps of the same material: ice, wood and rubber.',
  hint: 'Press Play: the ice block shoots away, the wood block creeps, the rubber block holds. Change a friction.',
  view: { position: [0, 4, 10], target: [0, 1, 0] },
  build() {
    const b = new Builder('Three ramps');
    const rad = (ANGLE * Math.PI) / 180;
    // Ramp-local (y, z) → world offset from the ramp centre, for a ramp tilted about the x axis.
    const onRamp = (y: number, z: number): [number, number] => [
      y * Math.cos(rad) - z * Math.sin(rad),
      y * Math.sin(rad) + z * Math.cos(rad),
    ];
    ['ice', 'wood', 'rubber'].forEach((material, i) => {
      const x = (i - 1) * 3;
      const centre: Vec3 = [x, 1.5, 0];
      b.body(`${material} ramp`, 'box', [2, 0.1, 6], centre, { bodyType: 'static', material, rotation: rotX(ANGLE) });
      // The block rests on the upper end: half the ramp thickness plus half the block, 2 m up the slope.
      const [dy, dz] = onRamp(0.25, -2);
      b.body(`${material} block`, 'box', [0.6, 0.4, 0.6], [x, centre[1] + dy, dz], { material, rotation: rotX(ANGLE) });
    });
    return b.done();
  },
});
