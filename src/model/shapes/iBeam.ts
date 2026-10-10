/** I-beam (H-section): two flanges joined by a web — girders, rails, joists. Three cuboids, a real section. */
import { makeBeam } from './beamSection';
import { SHAPE_ICONS } from './shapeIcons';

export const iBeam = makeBeam({
  id: 'i-beam',
  label: 'I-beam',
  icon: SHAPE_ICONS['i-beam'],
  blurb: 'Structural I-section girder: bridges, frames, rails',
  defaultSize: [2, 0.4, 0.3],
  flange: { default: 0.12, max: 0.4 },
  web: { default: 0.14, max: 0.6 },
  flangeLabel: 'Flange',
  webLabel: 'Web',
  rects: (W, H, tf, tw) => [
    { cz: 0, cy: -H / 2 + tf / 2, hz: W / 2, hy: tf / 2 },
    { cz: 0, cy: H / 2 - tf / 2, hz: W / 2, hy: tf / 2 },
    { cz: 0, cy: 0, hz: tw / 2, hy: (H - 2 * tf) / 2 },
  ],
  outline: (W, H, tf, tw) => [
    [-W / 2, -H / 2],
    [W / 2, -H / 2],
    [W / 2, -H / 2 + tf],
    [tw / 2, -H / 2 + tf],
    [tw / 2, H / 2 - tf],
    [W / 2, H / 2 - tf],
    [W / 2, H / 2],
    [-W / 2, H / 2],
    [-W / 2, H / 2 - tf],
    [-tw / 2, H / 2 - tf],
    [-tw / 2, -H / 2 + tf],
    [-W / 2, -H / 2 + tf],
  ],
});
